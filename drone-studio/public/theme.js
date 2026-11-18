// Apply the saved light or dark theme before the page draws, so the splash matches. A file, not inline, because the
// site's security policy allows no inline scripts.
try { var t = localStorage.getItem('armable.appearance.v1'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
