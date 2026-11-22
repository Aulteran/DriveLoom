// Phone shell: a header with the active-vehicle chip, one scrolling screen and
// a bottom tab bar with a raised Fill up action. Loaded by boot.js below the
// phone breakpoint only; never imported by the desktop shell (main.js), and it
// never imports main.js. Routes are the desktop's hash routes plus #/more and
// #/fill. Screens come from screens.js.
import { get, post, setCsrf, whenSignedOut } from '../api.js';
import { state, refreshSession, go, render, setRenderer, parse, PUBLIC, defaultVehicle, rememberVehicle } from '../core.js';
import { mount, h, toast } from '../ui.js';
import { icon } from '../icons.js';
import { vehicleTitle } from '../format.js';
import { themeControl } from '../theme.js';
import { screen } from './screens.js';
import { startSystem } from './system.js';
import { errorState } from './states.js';
import { phoneAuthView, rememberReturn, takeReturn, forgetReturn } from './auth.js';
import { closeSheets } from './sheet.js';
import { openVehicleSheet, initial } from './vehicle-sheet.js';
import { openFillUp, clearFillUpDrafts } from './fillup.js';

// ---------- one-off page setup ----------
function loadStyles() {
  // The shell's own styles, then the phone screens' (Home, History, Vehicles) and the system UI's.
  return Promise.all(['/mobile.css', '/mobile-screens.css', '/mobile-system.css'].map((href) => new Promise((resolve) => {
    const link = h('link', { rel: 'stylesheet', href });
    link.addEventListener('load', resolve);
    link.addEventListener('error', resolve);
    document.head.append(link);
  })));
}
// Draw under the notch and home indicator; the shell pads with env(safe-area-inset-*).
const vp = document.querySelector('meta[name="viewport"]');
if (vp && !/viewport-fit/.test(vp.content)) vp.content += ', viewport-fit=cover';
document.body.classList.add('m-shell');

// ---------- chrome ----------
const TABS = [['home', 'Home', 'gauge'], ['history', 'History', 'history'], ['fill', 'Fill up', 'plus'], ['vehicles', 'Vehicles', 'car'], ['more', 'More', 'grid']];
const tabLinks = {};
const chipText = h('span', { class: 'm-chip-name' });
const chipAvatar = h('span', { class: 'm-avatar m-avatar-sm', 'aria-hidden': 'true' });
// Named by its visible text after a hidden prefix, "Vehicle: Golf"; aria-haspopup says it opens the switcher.
const chip = h('button', { type: 'button', class: 'm-chip', 'aria-haspopup': 'dialog', hidden: true, onclick: switchVehicle },
  chipAvatar, h('span', { class: 'm-vh' }, 'Vehicle: '), chipText, icon('chevron', 'icon m-chip-caret'));
const head = h('header', { class: 'm-head', hidden: true },
  h('a', { class: 'brand m-brand', href: '#/' }, h('img', { src: '/icon.svg', alt: '', width: 28, height: 28 }), h('span', {}, 'DriveLoom')),
  chip);
const badge = h('span', { class: 'm-badge', hidden: true });
const tabs = h('nav', { class: 'm-tabs', 'aria-label': 'Main', hidden: true },
  h('ul', {}, TABS.map(([key, label, ic]) => {
    const a = h('a', { class: `m-tab m-tab-${key}`, href: '#/' },
      key === 'fill' ? h('span', { class: 'm-fab' }, icon(ic)) : icon(ic),
      h('span', { class: 'm-tab-label' }, label),
      key === 'more' ? badge : null);
    tabLinks[key] = a;
    return h('li', {}, a);
  })));
const main = document.getElementById('main');
main.before(head);
main.after(tabs);
startSystem({ head });

let active = null;   // the active vehicle: context for Home, History and Fill up
let currentTab = null;
let requests = 0;    // incoming friend requests, for the More badge

function chrome(signedIn, route = {}) {
  document.body.classList.toggle('m-signed-in', signedIn);
  head.hidden = !signedIn; tabs.hidden = !signedIn;
  if (!signedIn) return;
  active = route.vehicle ?? defaultVehicle();
  currentTab = route.tab ?? null;
  chip.hidden = !active;
  if (active) {
    chipText.textContent = vehicleTitle(active);
    chipAvatar.textContent = initial(active);
  }
  const hrefs = {
    home: active ? `#/vehicles/${active.id}` : '#/',
    history: active ? `#/vehicles/${active.id}/log` : '#/',
    fill: '#/fill', vehicles: '#/garage', more: '#/more',
  };
  for (const [key, a] of Object.entries(tabLinks)) {
    a.href = hrefs[key];
    if (key === currentTab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  badge.hidden = !requests;
  badge.replaceChildren(h('span', { 'aria-hidden': 'true' }, String(requests)), h('span', { class: 'm-vh' }, `(${requests} friend ${requests === 1 ? 'request' : 'requests'})`));
}

function switchVehicle() {
  openVehicleSheet(active, (v) => {
    const { parts } = parse();
    // Home and History follow the new vehicle; a vehicle page keeps its section.
    if (parts[0] === 'vehicles' && parts[1]) go(`#/vehicles/${v.id}${parts[2] && parts[2] !== 'stats' ? `/${parts[2]}` : ''}`);
    else if (currentTab === 'home') go(`#/vehicles/${v.id}`);
    // Elsewhere stay put; re-render, since a screen (the Vehicles list) may show the active vehicle.
    else render();
  });
}

async function signOut() {
  await post('/v1/auth/logout').catch(() => undefined);
  clearFillUpDrafts(); forgetReturn();
  state.account = null; setCsrf(null); go('#/signin');
}

const authScreen = (view) => h('div', { class: 'm-auth' }, h('div', { class: 'public-theme' }, themeControl(true)), view);

/** Full-screen "can't load" state (offline cold start, server down); retries by itself on reconnect. */
function unreachable(err) {
  closeSheets(); chrome(false); mountedHash = null;
  mount(h('div', { class: 'm-screen m-cold' }, errorState({ error: err, level: 1, onRetry: () => render() })), 'Can’t connect');
  addEventListener('online', () => render(), { once: true });
}

// ---------- render pipeline ----------
let rendering = 0;
let mountedHash = null;  // the route whose screen is in <main>
let skipHash = null;     // returning from the fill-up sheet: the screen is already there
let viaHashchange = false;

async function show(route, hash, ticket) {
  const r = await screen(route);
  if (ticket !== rendering) return false;
  if (r.redirect) { location.replace(r.redirect); return false; }
  chrome(true, r);
  mount(r.view, r.title);
  mountedHash = hash;
  return true;
}

async function renderPhone() {
  const ticket = ++rendering;
  const arrived = viaHashchange; viaHashchange = false;
  const { parts, query } = parse();
  const first = parts[0] ?? '';
  if (!state.instance) {
    // Offline or a server that does not answer is not "signed out": say so, and keep any typed draft.
    let failure = null;
    state.instance = await get('/v1/auth/instance').catch((err) => { failure = err; return null; });
    if (ticket !== rendering) return;
    if (!state.instance) {
      if (navigator.onLine === false || failure instanceof TypeError || failure?.status >= 500) { unreachable(failure); return; }
      state.instance = {};
    }
  }
  if (!state.account && !PUBLIC.has(first)) {
    if (navigator.onLine === false) { unreachable(new TypeError('offline')); return; }
    if (!(await refreshSession())) {
      rememberReturn(location.hash); // signing in here comes back to this route
      clearFillUpDrafts(); // the session ended: a typed fill-up must not outlive it
      if (ticket !== rendering) return;
      closeSheets(); chrome(false); mountedHash = null;
      mount(authScreen(await phoneAuthView(state.instance.needs_setup ? 'register' : 'signin', query)), 'Sign in');
      return;
    }
  }
  if (ticket !== rendering) return;
  try {
    if (PUBLIC.has(first)) { closeSheets(); chrome(false); mountedHash = null; mount(authScreen(await phoneAuthView(first, query)), 'Sign in'); return; }
    // Just signed in (password, passkey or the identity provider's redirect to #/): back to where sign-in interrupted.
    if (!first) { const back = takeReturn(); if (back && back !== location.hash) { location.replace(back); return; } }
    const [vehicles, friends] = await Promise.all([get('/v1/vehicles?includeArchived=true'), get('/v1/friends').catch(() => null)]);
    state.vehicles = vehicles.items;
    requests = friends?.incoming?.length ?? 0;
    if (ticket !== rendering) return;
    const ctx = { query, active: defaultVehicle(), requests, friends: friends?.friends?.length ?? 0, signOut };

    if (first === 'fill') {
      // The sheet opens over the screen the person came from, or over Home on a direct visit.
      const vehicle = active ?? ctx.active;
      if (!mountedHash) {
        const home = vehicle ? ['vehicles', vehicle.id] : [];
        if (!(await show({ ...ctx, parts: home, query: new URLSearchParams() }, `#/${home.join('/')}`, ticket))) return;
      } else chrome(true, { tab: currentTab, vehicle: active });
      const returnTo = mountedHash;
      const goBack = arrived;
      // A refresh on #/fill reopens the sheet for this vehicle, with its draft.
      if (active) rememberVehicle(active.id);
      openFillUp({
        vehicle: active,
        onClose: ({ saved } = {}) => {
          if (parse().parts[0] !== 'fill') return; // a link inside the sheet already navigated
          // After a save the screen underneath is rendered again, so it shows the new record.
          skipHash = saved ? null : returnTo;
          if (goBack) history.back(); else location.replace(returnTo);
        },
      });
      return;
    }
    // Legacy "add a fill-up" links (the dashboard's, bookmarks) open the sheet over the fuel log.
    if (first === 'vehicles' && parts[1] && parts[2] === 'log' && query.get('add') === '1') {
      closeSheets();
      const clean = `#/vehicles/${parts[1]}/log`;
      history.replaceState(null, '', clean);
      if (!(await show({ ...ctx, parts: parts.slice(0, 3), query: new URLSearchParams() }, clean, ticket))) return;
      openFillUp({ vehicle: active, onClose: ({ saved } = {}) => { if (saved && location.hash === clean) render(); } });
      return;
    }
    closeSheets();
    if (skipHash && skipHash === location.hash && mountedHash === skipHash) { skipHash = null; return; }
    skipHash = null;
    await show({ ...ctx, parts }, location.hash, ticket);
  } catch (err) {
    if (ticket !== rendering) return;
    chrome(!!state.account, { vehicle: state.account ? defaultVehicle() : null });
    mountedHash = null;
    mount(h('div', { class: 'm-screen' }, errorState({ error: err, level: 1, onRetry: () => render() }), h('a', { class: 'm-back m-center-self', href: '#/' }, 'Back to your dashboard')), 'Error');
    if (navigator.onLine === false) addEventListener('online', () => render(), { once: true });
  }
}

whenSignedOut(() => { clearFillUpDrafts(); if (state.account) { state.account = null; toast('Your session ended. Please sign in again.'); render(); } });
setRenderer(renderPhone);
window.addEventListener('hashchange', () => { viaHashchange = true; render(); });
await loadStyles();
render();
