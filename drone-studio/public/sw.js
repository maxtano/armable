/* Lucidity service worker: keeps the app itself available offline. It never caches the API, sign-in or MCP. */
const CACHE = 'lucidity-shell-v1';
const SHELL = ['/', '/favicon.svg', '/fonts/fonts.css'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const dynamic = path => /^\/(api|mcp|live|authorize|token|register|revoke|\.well-known)(\/|$)/.test(path);
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || dynamic(url.pathname)) return;
  // Built files have content hashes in their names: cache first.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/')) {
    event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(event.request, copy)); }
      return res;
    })));
    return;
  }
  // Pages: network first, falling back to the cached app.
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('/', copy)); }
      return res;
    }).catch(() => caches.match('/')));
  }
});
