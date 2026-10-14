const { io: connect } = require('socket.io-client');

// Tiny helpers shared by the test files.
async function api(base, method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}

async function signup(base, username, password = 'secret123') {
  await api(base, 'POST', '/api/auth/register', { username, password });
  const login = await api(base, 'POST', '/api/auth/login', { username, password });
  return login.body.token;
}

function client(base, token) {
  return connect(base, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
}

function connected(socket) {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

// Resolve with the next payload of `event` (optionally the first one matching `pred`).
function waitFor(socket, event, pred = () => true, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, ms);
    function handler(payload) {
      if (!pred(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

// True if NO matching event arrives within `ms`.
function expectNothing(socket, event, ms = 400) {
  return new Promise((resolve, reject) => {
    const handler = (p) => { clearTimeout(timer); reject(new Error(`unexpected "${event}": ${JSON.stringify(p).slice(0, 120)}`)); };
    const timer = setTimeout(() => { socket.off(event, handler); resolve(); }, ms);
    socket.on(event, handler);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = { api, signup, client, connected, waitFor, expectNothing, sleep };
