// Applies a saved light or dark override before the first paint. A classic,
// external script: the CSP blocks inline scripts. Must stay tiny and safe to fail.
try {
  var saved = localStorage.getItem('driveloom.theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
} catch (e) { /* storage blocked: follow the system */ }
