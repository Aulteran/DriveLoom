// App-wide status for the phone shell: the connection pill under the header,
// the offline banner, the "update available" banner and the offline write
// guard. Built once at start-up, outside <main>, so screen renders never move
// or re-announce them; announcements go to one polite live region.
//
// Updates are prompt-only: the banner appears when pwa.js reports a waiting
// worker, never while a sheet or dialog is open or a form has unsaved input
// (it waits and appears once that closes), and the page reloads only when
// Reload is tapped. Offline, nothing is written: submits are stopped with an
// explanation (the fill-up sheet handles its own Save) and the pill says when
// the screen on show was loaded.
import { h, toast } from '../ui.js';
import { icon } from '../icons.js';
import { onUpdateAvailable, applyUpdate, isOnline, onConnectionChange } from '../pwa.js';
import { OFFLINE_SAVE } from './kit.js';
import { trackTouched, updateHeld } from '../dirty.js';

let loadedAt = null;           // when the screen on show finished loading, while online
let updateWaiting = false;
let updateDismissed = false;
let offlineDismissed = false;

const announcer = h('div', { class: 'm-vh', role: 'status', 'aria-live': 'polite' });
const announce = (text) => { announcer.textContent = ''; setTimeout(() => { announcer.textContent = text; }, 50); };

const pillText = h('span', {});
const pill = h('div', { class: 'm-conn', hidden: true }, h('span', { class: 'm-conn-pill' }, h('span', { class: 'm-conn-dot', 'aria-hidden': 'true' }), pillText));

const updateBanner = h('div', { class: 'm-banner m-banner-update', hidden: true },
  h('span', { class: 'm-banner-icon' }, icon('refresh')),
  h('p', { class: 'm-banner-text' }, h('strong', {}, 'Update available'), h('span', {}, 'Reload to use the new version.')),
  h('button', { type: 'button', class: 'm-banner-go', onclick: () => {
    updateBanner.querySelector('.m-banner-go').disabled = true;
    applyUpdate();
    // Another tab may already have activated the new version: then nothing takes over here, so reload anyway.
    setTimeout(() => location.reload(), 4000);
  } }, 'Reload'),
  h('button', { type: 'button', class: 'm-icon-btn m-banner-x', 'aria-label': 'Later', onclick: () => { updateDismissed = true; sync(); } }, icon('close')));

const offlineBanner = h('div', { class: 'm-banner m-banner-offline', hidden: true },
  h('span', { class: 'm-banner-icon' }, icon('wifi')),
  h('p', { class: 'm-banner-text' }, h('strong', {}, 'You’re offline.'), h('span', {}, 'You can read what is already on screen. Saving needs a connection, so it is paused until you’re back.')),
  h('button', { type: 'button', class: 'm-icon-btn m-banner-x', 'aria-label': 'Dismiss', onclick: () => { offlineDismissed = true; sync(); } }, icon('close')));

const stack = h('aside', { class: 'm-banners', 'aria-label': 'App status' }, offlineBanner, updateBanner);

const slow = () => ['slow-2g', '2g'].includes(navigator.connection?.effectiveType);
const clock = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function sync() {
  const online = isOnline();
  document.body.classList.toggle('m-offline', !online);
  // Pill: only when something is wrong.
  if (!online) pillText.textContent = loadedAt ? `Offline · loaded at ${clock(loadedAt)}` : 'Offline';
  else if (slow()) pillText.textContent = 'Slow connection';
  pill.hidden = online && !slow();
  pill.classList.toggle('m-conn-slow', online);
  offlineBanner.hidden = online || offlineDismissed;
  const showUpdate = updateWaiting && !updateDismissed && !updateHeld();
  if (showUpdate && updateBanner.hidden) announce('Update available. Reload to use the new version.');
  if (showUpdate || !updateWaiting || updateDismissed) updateBanner.hidden = !showUpdate;
  // Lift the toast above whatever banners are on show.
  const hgt = stack.offsetHeight;
  document.documentElement.style.setProperty('--m-banners-h', `${hgt}px`);
}

/** Start once, from the shell. `head` is the shell header; the pill sits right below it. */
export function startSystem({ head }) {
  head.after(pill);
  document.body.append(stack, announcer);

  onConnectionChange((online) => {
    if (online) { offlineDismissed = false; toast('You’re back online.'); }
    else announce('You’re offline. Saving is paused until you’re back.');
    sync();
  });
  navigator.connection?.addEventListener?.('change', sync);
  onUpdateAvailable(() => { updateWaiting = true; sync(); });

  // Unsaved input: any typing in a form marks it until it is reset or replaced (a save re-renders it).
  // The tracking itself lives in dirty.js, which the entry point also uses to hold a shell switch.
  trackTouched();
  document.addEventListener('reset', () => setTimeout(sync), true);
  // Offline, nothing is written. The fill-up sheet disables its own Save and says why.
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (!isOnline() && !f.closest('.m-fill')) {
      e.preventDefault(); e.stopImmediatePropagation();
      offlineDismissed = false; sync();
      toast(OFFLINE_SAVE);
      return;
    }
    // Still unsaved until the screen replaces the form (a failed save keeps the hold).
    setTimeout(sync, 0);
  }, true);
  // `close` does not bubble, so listen in the capture phase for every dialog.
  document.addEventListener('close', () => setTimeout(sync, 0), true);
  addEventListener('hashchange', () => setTimeout(sync, 0));
  // A new screen in <main>: note when it loaded and re-check the held update.
  const main = document.getElementById('main');
  new MutationObserver(() => { if (isOnline()) loadedAt = new Date(); sync(); }).observe(main, { childList: true });
  // Typing in a form that is then abandoned (re-rendered) is caught by the observer; this covers the rest.
  setInterval(() => { if (updateWaiting && updateBanner.hidden && !updateDismissed) sync(); }, 1500);
  sync();
}
