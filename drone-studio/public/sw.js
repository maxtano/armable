/* Armable service worker: keeps both workspaces available offline. It never caches the API, sign-in or MCP. */
const CACHE = 'armable-shell-v2';
const SHELL = ['/', '/favicon.svg', '/fonts/fonts.css'];
/* The bench and Armable Shows are separate pages, so each is cached under its own key. */
const shell = path => (/^\/show(\/|$)/.test(path) ? '/show' : '/');
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
    const key = shell(url.pathname);
    event.respondWith(fetch(event.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key)));
  }
});
