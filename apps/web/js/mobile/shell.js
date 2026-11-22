// Phone shell: a header with the active-vehicle chip, one scrolling screen and
// a bottom tab bar with a raised Fill up action. Loaded by boot.js below the
// phone breakpoint only; never imported by the desktop shell (main.js), and it
// never imports main.js. Routes are the desktop's hash routes plus #/more and
// #/fill. Screens come from screens.js.
import { get, post, setCsrf, whenSignedOut } from '../api.js';
import { state, refreshSession, go, render, setRenderer, parse, PUBLIC, defaultVehicle } from '../core.js';
import { mount, h, toast } from '../ui.js';
import { icon } from '../icons.js';
import { vehicleTitle } from '../format.js';
import { themeControl } from '../theme.js';
import { authView } from '../views/auth.js';
import { screen } from './screens.js';
import { closeSheets } from './sheet.js';
import { openVehicleSheet, initial } from './vehicle-sheet.js';
import { openFillUp } from './fillup.js';

// ---------- one-off page setup ----------
function loadStyles() {
  return new Promise((resolve) => {
    const link = h('link', { rel: 'stylesheet', href: '/mobile.css' });
    link.addEventListener('load', resolve);
    link.addEventListener('error', resolve);
    document.head.append(link);
  });
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
    else chrome(true, { tab: currentTab, vehicle: v });
  });
}

async function signOut() {
  await post('/v1/auth/logout').catch(() => undefined);
  state.account = null; setCsrf(null); go('#/signin');
}

const authScreen = (view) => h('div', { class: 'm-auth' }, h('div', { class: 'public-theme' }, themeControl(true)), view);

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
  if (!state.instance) state.instance = await get('/v1/auth/instance').catch(() => ({}));
  if (!state.account && !PUBLIC.has(first)) {
    if (!(await refreshSession())) {
      if (ticket !== rendering) return;
      closeSheets(); chrome(false); mountedHash = null;
      mount(authScreen(await authView(state.instance.needs_setup ? 'register' : 'signin', query)), 'Sign in');
      return;
    }
  }
  if (ticket !== rendering) return;
  try {
    if (PUBLIC.has(first)) { closeSheets(); chrome(false); mountedHash = null; mount(authScreen(await authView(first, query)), 'Sign in'); return; }
    const [vehicles, friends] = await Promise.all([get('/v1/vehicles?includeArchived=true'), get('/v1/friends').catch(() => null)]);
    state.vehicles = vehicles.items;
    requests = friends?.incoming?.length ?? 0;
    if (ticket !== rendering) return;
    const ctx = { query, active: defaultVehicle(), requests, signOut };

    if (first === 'fill') {
      // The sheet opens over the screen the person came from, or over Home on a direct visit.
      const vehicle = active ?? ctx.active;
      if (!mountedHash) {
        const home = vehicle ? ['vehicles', vehicle.id] : [];
        if (!(await show({ ...ctx, parts: home, query: new URLSearchParams() }, `#/${home.join('/')}`, ticket))) return;
      } else chrome(true, { tab: currentTab, vehicle: active });
      const returnTo = mountedHash;
      const goBack = arrived;
      openFillUp({
        vehicle: active,
        onClose: () => {
          if (parse().parts[0] !== 'fill') return; // a link inside the sheet already navigated
          skipHash = returnTo;
          if (goBack) history.back(); else location.replace(returnTo);
        },
      });
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
    mount(h('div', { class: 'panel' }, h('h1', {}, err.status === 404 ? 'Not found' : 'Something went wrong'), h('p', { class: 'muted' }, err.message), h('a', { href: '#/' }, 'Back to your dashboard')), 'Error');
  }
}

whenSignedOut(() => { if (state.account) { state.account = null; toast('Your session ended. Please sign in again.'); render(); } });
setRenderer(renderPhone);
window.addEventListener('hashchange', () => { viaHashchange = true; render(); });
await loadStyles();
render();
