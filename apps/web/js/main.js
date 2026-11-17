// Client-side router, session state and the signed-in app shell (sidebar with
// the vehicle switcher). Hash routes keep the server simple: every non-API path
// serves index.html, and the fragment never reaches it.
import { get, post, setCsrf, whenSignedOut } from './api.js';
import { mount, h, toast } from './ui.js';
import { icon } from './icons.js';
import { vehicleLabel, vehicleTitle } from './format.js';
import { themeControl } from './theme.js';
import { authView } from './views/auth.js';
import { garageView, welcomeView } from './views/vehicles.js';
import { vehicleView } from './views/vehicle.js';
import { friendsView } from './views/friends.js';
import { settingsView } from './views/settings.js';
import { adminView } from './views/admin.js';

export const state = { account: null, prefs: null, instance: null, vehicles: [] };

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

// ---------- selected vehicle ----------
// The URL is the source of truth; storage only answers "which vehicle does #/ open?".
const lastKey = () => `driveloom.vehicle.${state.account?.id ?? ''}`;
function rememberVehicle(id) { try { localStorage.setItem(lastKey(), id); } catch { /* not remembered */ } }
function recalledVehicle() { try { return localStorage.getItem(lastKey()); } catch { return null; } }

function defaultVehicle() {
  const active = state.vehicles.filter((v) => !v.archived);
  return active.find((v) => v.id === recalledVehicle()) ?? active[0] ?? null;
}

// ---------- shell ----------
const VEHICLE_NAV = [['', 'Dashboard', 'gauge'], ['log', 'Fuel log', 'fuel'], ['members', 'Members', 'users'], ['data', 'Import & export', 'swap'], ['settings', 'Vehicle settings', 'gear']];
const ACCOUNT_NAV = [['garage', 'Garage', 'garage'], ['friends', 'Friends', 'user'], ['settings', 'Settings', 'sliders'], ['admin', 'Administration', 'shield']];
const mobile = matchMedia('(max-width: 900px)');

const navLink = (href, label, ic, current) => h('a', { href, 'aria-current': current ? 'page' : undefined }, icon(ic), h('span', {}, label));

function switcher(current) {
  const list = state.vehicles.filter((v) => !v.archived || v.id === current?.id);
  if (!list.length) return null;
  const sel = h('select', {
    id: 'vehicle-switch', name: 'vehicle',
    onchange: (e) => { rememberVehicle(e.target.value); go(`#/vehicles/${e.target.value}`); },
  }, list.map((v) => h('option', { value: v.id, selected: v.id === current?.id }, v.archived ? `${vehicleLabel(v)} (archived)` : vehicleLabel(v))));
  return h('div', { class: 'switcher' }, h('label', { for: 'vehicle-switch' }, 'Vehicle'), sel);
}

function buildSidebar(route) {
  const { section, vehicle, tab } = route;
  const sb = document.getElementById('sidebar');
  const admin = state.account?.instanceRole === 'admin';
  const who = state.account?.displayName || state.account?.email || '';
  sb.replaceChildren(h('div', { class: 'sidebar-inner' },
    h('div', { class: 'sidebar-head' },
      h('a', { class: 'brand', href: '#/' }, h('img', { src: '/icon.svg', alt: '', width: 30, height: 30 }), h('span', {}, 'DriveLoom')),
      h('button', { type: 'button', class: 'ghost icon-only drawer-close', 'aria-label': 'Close menu', onclick: () => setDrawer(false) }, icon('close'))),
    switcher(vehicle),
    vehicle ? h('nav', { class: 'side-nav', 'aria-label': 'Vehicle' },
      h('div', { class: 'side-label' }, 'This vehicle'),
      VEHICLE_NAV.map(([key, label, ic]) => navLink(`#/vehicles/${vehicle.id}${key ? `/${key}` : ''}`, label, ic, section === 'vehicle' && tab === (key || 'overview')))) : null,
    h('nav', { class: 'side-nav', 'aria-label': 'Account' },
      h('div', { class: 'side-label' }, 'Account'),
      ACCOUNT_NAV.filter(([key]) => key !== 'admin' || admin).map(([key, label, ic]) => navLink(`#/${key}`, label, ic, section === key))),
    h('div', { class: 'sidebar-foot' },
      themeControl(),
      h('div', { class: 'who' },
        h('span', { class: 'avatar', 'aria-hidden': 'true' }, (who[0] ?? '?').toUpperCase()),
        h('span', { class: 'who-name', title: who }, who),
        h('button', { type: 'button', class: 'ghost icon-only', id: 'signout', 'aria-label': 'Sign out', title: 'Sign out', onclick: signOut }, icon('logout'))))));
}

let drawerOpen = false;
function setDrawer(open) {
  drawerOpen = open && mobile.matches;
  const sb = document.getElementById('sidebar');
  document.body.classList.toggle('drawer-open', drawerOpen);
  document.getElementById('scrim').hidden = !drawerOpen;
  document.getElementById('menu-open').setAttribute('aria-expanded', String(drawerOpen));
  // Off-canvas on phones: unreachable by keyboard and screen readers until opened.
  sb.inert = mobile.matches && !drawerOpen;
  // While the drawer is open it acts as a modal: the page behind it is inert.
  document.getElementById('main').inert = drawerOpen;
  document.getElementById('mobilebar').inert = drawerOpen;
  if (drawerOpen) sb.querySelector('a, button, select')?.focus();
}

function chrome(signedIn, route) {
  document.body.classList.toggle('signed-in', signedIn);
  document.getElementById('sidebar').hidden = !signedIn;
  document.getElementById('mobilebar').hidden = !signedIn;
  if (signedIn) buildSidebar(route ?? {});
  else {
    // The sidebar (and its theme control) is hidden here, so offer the control on its own.
    document.getElementById('sidebar').replaceChildren();
  }
  setDrawer(false);
}

async function signOut() {
  await post('/v1/auth/logout').catch(() => undefined);
  state.account = null; setCsrf(null); go('#/signin');
}

const notFound = () => h('div', { class: 'panel empty' }, h('h1', {}, 'Not found'), h('p', {}, h('a', { href: '#/' }, 'Back to your dashboard')));

function withPublicTheme(view) {
  return h('div', {}, h('div', { class: 'public-theme' }, themeControl(true)), view);
}

let rendering = 0;
export async function render() {
  const ticket = ++rendering;
  const { parts, query } = parse();
  const [first = '', second, third] = parts;
  if (!state.instance) state.instance = await get('/v1/auth/instance').catch(() => ({}));
  if (!state.account && !PUBLIC.has(first)) {
    if (!(await refreshSession())) {
      if (ticket !== rendering) return;
      chrome(false);
      mount(withPublicTheme(await authView(state.instance.needs_setup ? 'register' : 'signin', query)), 'Sign in');
      return;
    }
  }
  if (ticket !== rendering) return;
  try {
    if (PUBLIC.has(first)) { chrome(false); mount(withPublicTheme(await authView(first, query)), 'Sign in'); return; }
    // The switcher needs the current list on every render, so it never goes stale.
    state.vehicles = (await get('/v1/vehicles?includeArchived=true')).items;
    if (ticket !== rendering) return;
    if (first === '') {
      const v = defaultVehicle();
      if (v) { location.replace(`#/vehicles/${v.id}`); return; }
      chrome(true, { section: 'home' });
      mount(await welcomeView(), 'Welcome');
      return;
    }
    let view, title, route;
    switch (first) {
      case 'vehicles': {
        if (!second) { location.replace('#/garage'); return; }
        const tab = !third || third === 'stats' ? 'overview' : third;
        const r = await vehicleView(second, tab, query);
        rememberVehicle(r.vehicle.id);
        // An archived vehicle opened from the garage is not in the default list but must show as selected.
        const listed = state.vehicles.find((x) => x.id === r.vehicle.id);
        [view, title, route] = [r.view, `${r.title} · ${vehicleTitle(r.vehicle)}`, { section: 'vehicle', tab, vehicle: listed ?? r.vehicle }];
        break;
      }
      case 'garage': [view, title, route] = [await garageView(query), 'Garage', { section: 'garage' }]; break;
      case 'friends': [view, title, route] = [await friendsView(query), 'Friends', { section: 'friends' }]; break;
      case 'settings': case 'account': [view, title, route] = [await settingsView(second ?? 'preferences', query), 'Settings', { section: 'settings' }]; break;
      case 'admin': [view, title, route] = [await adminView(second ?? 'users', query), 'Administration', { section: 'admin' }]; break;
      default: [view, title, route] = [notFound(), 'Not found', {}];
    }
    if (ticket !== rendering) return;
    // Keep the vehicle switcher meaningful outside vehicle pages too.
    if (!route.vehicle) route.vehicle = defaultVehicle();
    chrome(true, route);
    mount(view, title);
  } catch (err) {
    if (ticket !== rendering) return;
    chrome(!!state.account, { vehicle: state.account ? defaultVehicle() : null });
    mount(h('div', { class: 'panel' }, h('h1', {}, err.status === 404 ? 'Not found' : 'Something went wrong'), h('p', { class: 'muted' }, err.message), h('a', { href: '#/' }, 'Back to your dashboard')), 'Error');
  }
}

// ---------- drawer wiring (phones) ----------
document.getElementById('menu-open').append(icon('menu'));
document.getElementById('menu-open').addEventListener('click', () => setDrawer(true));
document.getElementById('scrim').addEventListener('click', () => setDrawer(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawerOpen) { setDrawer(false); document.getElementById('menu-open').focus(); }
});
mobile.addEventListener('change', () => setDrawer(false));

whenSignedOut(() => { if (state.account) { state.account = null; toast('Your session ended. Please sign in again.'); render(); } });
window.addEventListener('hashchange', render);
render();
