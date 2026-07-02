const express = require('express');
const router = express.Router();

const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FAILURE_TTL_MS = 5 * 60 * 1000; // 5 min for failures (avoid hammering bad URLs)
const FETCH_TIMEOUT_MS = 5000;

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

router.get('/', async (req, res) => {
  const { url } = req.query;

  if (!url || !/^https?:\/\//i.test(url)) {
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

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; iChat/1.0)',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    clearTimeout(timer);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      cache.set(url, { data: empty, expiresAt: Date.now() + CACHE_TTL_MS });
      return res.json(empty);
    }

    const fullHtml = await response.text();
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

    cache.set(url, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    res.json(data);
  } catch {
    cache.set(url, { data: empty, expiresAt: Date.now() + FAILURE_TTL_MS });
    res.json(empty);
  }
});

module.exports = router;
