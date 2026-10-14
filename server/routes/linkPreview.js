const express = require('express');
const dns = require('dns').promises;
const net = require('net');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FAILURE_TTL_MS = 5 * 60 * 1000; // 5 min for failures (avoid hammering bad URLs)
const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const MAX_CACHE_ENTRIES = 500;
const MAX_HTML_BYTES = 256 * 1024;

// Link previews fetch URLs on the server, so we must never let a user point us at
// internal addresses (localhost, cloud metadata at 169.254.x.x, private networks...).
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    // IPv4-mapped addresses, written either ::ffff:1.2.3.4 or ::ffff:0102:0304
    const dotted = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateAddress(dotted[1]);
    const hex = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return false;
  }
  return true;
}

async function assertPublicUrl(rawUrl) {
  const u = new URL(rawUrl);
  if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some(a => isPrivateAddress(a.address))) throw new Error('blocked address');
}

// Follows redirects by hand so every hop is checked, not just the first URL.
async function safeFetch(startUrl, signal) {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const response = await fetch(current, {
      signal,
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; iChat/1.0)',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      current = new URL(response.headers.get('location'), current).href;
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new Error('too many redirects');
}

function remember(url, data, ttl) {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(url, { data, expiresAt: Date.now() + ttl });
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

// Handles both attribute orderings: property/name before content, and content before property/name
function extractMetaTag(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeEntities(m[1].trim());
  }
  return null;
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m?.[1] ? decodeEntities(m[1].trim()) : null;
}

router.get('/', requireAuth, async (req, res) => {
  const { url } = req.query;

  if (typeof url !== 'string' || url.length > 2000 || !/^https?:\/\//i.test(url)) {
    return res.json({ title: null, description: null, image: null, siteName: null, url: url || '' });
  }

  let hostname = '';
  try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch { /* malformed */ }

  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json(cached.data);
  }

  const empty = { title: null, description: null, image: null, siteName: hostname || null, url };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response;
    try {
      ({ response } = await safeFetch(url, controller.signal));
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      remember(url, empty, CACHE_TTL_MS);
      return res.json(empty);
    }

    const fullHtml = (await response.text()).slice(0, MAX_HTML_BYTES);
    // Only scan the <head> — meta tags live there; avoids processing huge page bodies
    const headEnd = fullHtml.toLowerCase().indexOf('</head>');
    const html = headEnd !== -1 ? fullHtml.slice(0, headEnd + 7) : fullHtml.slice(0, 60000);

    let image = extractMetaTag(html, 'og:image');
    if (image && !image.startsWith('http')) {
      try { image = new URL(image, url).href; } catch { image = null; }
    }

    const data = {
      title: extractMetaTag(html, 'og:title') || extractTitle(html),
      description: extractMetaTag(html, 'og:description') || extractMetaTag(html, 'description'),
      image,
      siteName: extractMetaTag(html, 'og:site_name') || hostname || null,
      url,
    };

    remember(url, data, CACHE_TTL_MS);
    res.json(data);
  } catch {
    remember(url, empty, FAILURE_TTL_MS);
    res.json(empty);
  }
});

module.exports = router;
