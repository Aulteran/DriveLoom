// Route table of the phone shell. Each entry turns a hash route into a screen:
// { view, title, tab, vehicle? } or { redirect }. Most screens are interim
// adapters around the desktop views; a later chunk swaps an entry for a
// phone-native screen without touching the shell.
import { h } from '../ui.js';
import { icon } from '../icons.js';
import { state } from '../core.js';
import { vehicleTitle } from '../format.js';
import { garageView, welcomeView } from '../views/vehicles.js';
import { vehicleView } from '../views/vehicle.js';
import { moreView } from './more.js';
import { installView } from './install.js';
import { friendsScreen } from './friends.js';
import { settingsScreen, profileScreen, securityScreen } from './account.js';
import { adminScreen } from './admin.js';

// Tabs: home, history, fill, vehicles, more.
const VEHICLE_TAB = { overview: 'home', log: 'history', members: 'vehicles', data: 'vehicles', settings: 'vehicles' };
const VEHICLE_SECTIONS = [['members', 'Members', 'users'], ['data', 'Import & export', 'swap'], ['settings', 'Vehicle settings', 'gear']];

const back = (href, label) => h('a', { class: 'm-back', href }, icon('back'), label);
const withBack = (href, label, view) => h('div', { class: 'm-screen' }, back(href, label), view);

/** The vehicle's own pages, which the desktop sidebar links and the phone has no room for. */
function vehicleSections(v, current) {
  return h('nav', { class: 'm-group', 'aria-label': current ? 'Vehicle sections' : `${vehicleTitle(v)} sections` },
    current ? null : h('h2', { class: 'm-label m-pad-x' }, vehicleTitle(v)),
    h('ul', {}, VEHICLE_SECTIONS.map(([key, label, ic]) => h('li', {},
      h('a', { class: 'm-row', href: `#/vehicles/${v.id}/${key}`, 'aria-current': key === current ? 'page' : undefined },
        icon(ic), h('span', { class: 'm-row-label' }, label), icon('next', 'icon m-row-next'))))));
}

const notFound = () => h('div', { class: 'panel empty' }, h('h1', {}, 'Not found'), h('p', {}, h('a', { href: '#/' }, 'Back to your dashboard')));

/** ctx: { parts, query, active, requests, signOut } */
export async function screen({ parts, query, active, requests, signOut }) {
  const [first = '', second, third] = parts;
  switch (first) {
    case '':
      if (active) return { redirect: `#/vehicles/${active.id}` };
      return { view: await welcomeView(), title: 'Welcome', tab: 'home' };
    case 'vehicles': {
      if (!second) return { redirect: '#/garage' };
      const tab = !third || third === 'stats' ? 'overview' : third;
      const r = await vehicleView(second, tab, query);
      // An archived vehicle opened from the garage is not in the default list but is still the context.
      const vehicle = state.vehicles.find((x) => x.id === r.vehicle.id) ?? r.vehicle;
      const section = VEHICLE_TAB[tab] === 'vehicles';
      const view = section ? withBack('#/garage', 'Vehicles', h('div', {}, r.view, vehicleSections(vehicle, tab))) : r.view;
      return { view, title: `${r.title} · ${vehicleTitle(r.vehicle)}`, tab: VEHICLE_TAB[tab] ?? 'home', vehicle };
    }
    case 'garage':
      return { view: h('div', {}, await garageView(query), active ? vehicleSections(active) : null), title: 'Vehicles', tab: 'vehicles' };
    case 'more':
      if (second === 'install') return { view: installView(), title: 'Install the app', tab: 'more' };
      return { view: await moreView({ requests, onSignOut: signOut }), title: 'More', tab: 'more' };
    case 'friends':
      return { view: friendsScreen(query), title: 'Friends', tab: 'more' };
    case 'settings': case 'account': {
      // The identity-provider link flow returns to #/account?linked=1.
      const sec = query.get('linked') === '1' || first === 'account' ? 'security' : second;
      if (sec === 'security') return { view: securityScreen(query), title: 'Account and security', tab: 'more' };
      if (sec === 'profile') return { view: profileScreen(), title: 'Profile', tab: 'more' };
      return { view: settingsScreen(), title: 'Settings', tab: 'more' };
    }
    case 'admin':
      return { view: adminScreen(second ?? 'users', query), title: 'Administration', tab: 'more' };
    default:
      return { view: notFound(), title: 'Not found', tab: null };
  }
}
