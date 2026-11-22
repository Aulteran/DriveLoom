// Entry point: picks one of two shells at start-up. Phones get the tab-bar
// shell in mobile/; tablets and wide windows get the desktop sidebar shell in
// main.js. Both read the same hash routes and share core.js and the views.
// Crossing the breakpoint while running (rotation, a resized window) reloads
// into the other shell rather than swapping shells in place.
const phone = matchMedia('(max-width: 699px)');
const isPhone = phone.matches;
phone.addEventListener('change', () => { if (phone.matches !== isPhone) location.reload(); });

import('./pwa.js').then((pwa) => pwa.start());

if (isPhone) {
  import('./mobile/shell.js');
} else {
  // Routes only the phone shell knows land on the dashboard instead of "Not found".
  const first = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  if (first === 'more' || first === 'fill') location.replace('#/');
  import('./main.js');
}
