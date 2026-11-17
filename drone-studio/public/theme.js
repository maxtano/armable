/* Settle the appearance before the first paint, so the bench never flashes the wrong theme.
 * A choice the person made wins; otherwise follow the system. Mirrored in src/web/App.tsx.
 * A separate file rather than an inline script: the server's CSP is script-src 'self'. */
(function () {
  var root = document.documentElement, saved = null;
  try { saved = localStorage.getItem('lucidity.appearance.v1'); } catch (e) { /* private mode */ }
  var dark = !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = saved === 'light' || saved === 'dark' ? saved : dark ? 'dark' : 'light';
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', root.dataset.theme === 'light' ? '#f6f3ec' : '#161819');
})();
