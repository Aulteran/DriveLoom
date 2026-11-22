// Entry point: picks one of two shells at start-up. Phones get the tab-bar
// shell in mobile/; tablets and wide windows get the desktop sidebar shell in
// main.js. Both read the same hash routes and share core.js and the views.
// Crossing the boundary while running (a resized window, a folding phone) reloads
// into the other shell rather than swapping shells in place, but never over
// unsaved input: the reload waits until nothing would be lost.
import { hasUnsavedInput } from './dirty.js';

// The one definition of "phone". Narrow windows are phones. The second clause keeps a
// phone rotated to landscape (about 844x390, touch) on the phone shell instead of
// flipping it to the desktop layout; tablets and desktop windows are taller than
// 500px or have a fine pointer, so they keep the desktop shell.
const phone = matchMedia('(max-width: 699px), (max-height: 500px) and (pointer: coarse)');
const isPhone = phone.matches;

let waiting = false;
function maybeSwitch() {
  if (phone.matches === isPhone) { waiting = false; return; }
  if (hasUnsavedInput()) { waiting = true; return; }
  location.reload();
}
phone.addEventListener('change', maybeSwitch);
// While held, look again whenever the input could have been dealt with, and on a timer for the rest.
for (const ev of ['input', 'change', 'close', 'hashchange', 'visibilitychange']) addEventListener(ev, () => { if (waiting) setTimeout(maybeSwitch, 0); }, true);
setInterval(() => { if (waiting) maybeSwitch(); }, 2000);

import('./pwa.js').then((pwa) => pwa.start());

if (isPhone) {
  import('./mobile/shell.js');
} else {
  // Routes only the phone shell knows land on the dashboard instead of "Not found".
  const first = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  if (first === 'more' || first === 'fill') location.replace('#/');
  import('./main.js');
}
