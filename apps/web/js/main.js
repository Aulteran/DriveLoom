// Client-side router and session state. Hash routes keep the server simple:
// every non-API path serves index.html, and the fragment never reaches it.
import { get, post, setCsrf, whenSignedOut } from './api.js';
import { mount, h, toast } from './ui.js';
import { icon } from './icons.js';
import { authView } from './views/auth.js';
import { vehiclesView } from './views/vehicles.js';
import { vehicleView } from './views/vehicle.js';
import { friendsView } from './views/friends.js';
import { settingsView } from './views/settings.js';
import { adminView } from './views/admin.js';

export const state = { account: null, prefs: null, instance: null };

/** Load (or reload) the signed-in account. Returns false when signed out. */
export async function refreshSession() {
  try {
    const s = await get('/v1/auth/session', { quiet: true });
    setCsrf(s.csrf_token);
    state.account = s.account;
    state.prefs = await get('/v1/preferences');
    return true;
  } catch { state.account = null; setCsrf(null); return false; }
}

export function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

const PUBLIC = new Set(['signin', 'register', 'recover', 'mfa']);

function parse() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  return { parts: (path ?? '').split('/').filter(Boolean), query: new URLSearchParams(qs ?? '') };
}

function chrome(signedIn, section) {
  document.getElementById('topbar').hidden = !signedIn;
  document.getElementById('nav-admin').hidden = state.account?.instanceRole !== 'admin';
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === section) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

let rendering = 0;
export async function render() {
  const ticket = ++rendering;
  const { parts, query } = parse();
  const [first = '', second, third] = parts;
  if (!state.instance) state.instance = await get('/v1/auth/instance').catch(() => ({}));
  if (!state.account && !PUBLIC.has(first)) {
    if (!(await refreshSession())) { chrome(false); if (ticket === rendering) mount(await authView(state.instance.needs_setup ? 'register' : 'signin', query), 'Sign in'); return; }
  }
  if (ticket !== rendering) return;
  try {
    if (PUBLIC.has(first)) { chrome(false); mount(await authView(first, query), 'Sign in'); return; }
    let view, title, section;
    switch (first) {
      case '': [view, title, section] = [await vehiclesView(query), 'Vehicles', 'vehicles']; break;
      case 'vehicles': [view, title, section] = [await vehicleView(second, third ?? 'log', query), 'Vehicle', 'vehicles']; break;
      case 'friends': [view, title, section] = [await friendsView(query), 'Friends', 'friends']; break;
      case 'settings': case 'account': [view, title, section] = [await settingsView(second ?? 'preferences', query), 'Settings', 'settings']; break;
      case 'admin': [view, title, section] = [await adminView(second ?? 'users', query), 'Administration', 'admin']; break;
      default: [view, title, section] = [h('div', { class: 'panel empty' }, h('h1', {}, 'Not found'), h('p', {}, h('a', { href: '#/' }, 'Back to your vehicles'))), 'Not found', ''];
    }
    if (ticket !== rendering) return;
    chrome(true, section);
    mount(view, title);
  } catch (err) {
    if (ticket !== rendering) return;
    chrome(!!state.account, '');
    mount(h('div', { class: 'panel' }, h('h1', {}, err.status === 404 ? 'Not found' : 'Something went wrong'), h('p', { class: 'muted' }, err.message), h('a', { href: '#/' }, 'Back to your vehicles')), 'Error');
  }
}

// Decorative icons for the static navigation.
const NAV_ICONS = { vehicles: 'car', friends: 'users', settings: 'sliders', admin: 'shield' };
for (const a of document.querySelectorAll('[data-nav]')) a.prepend(icon(NAV_ICONS[a.dataset.nav]));
document.getElementById('signout').prepend(icon('logout'));

whenSignedOut(() => { if (state.account) { state.account = null; toast('Your session ended. Please sign in again.'); render(); } });
document.getElementById('signout').addEventListener('click', async () => {
  await post('/v1/auth/logout').catch(() => undefined);
  state.account = null; setCsrf(null); go('#/signin');
});
window.addEventListener('hashchange', render);
render();
