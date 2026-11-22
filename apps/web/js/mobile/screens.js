// Route table of the phone shell. Each entry turns a hash route into a screen:
// { view, title, tab, vehicle? } or { redirect }. Home, History and Vehicles
// (a vehicle's detail hub and its sections) are phone-native screens; the
// others are still interim adapters around the desktop views, which a later
// chunk swaps for phone-native screens without touching the shell.
import { h } from '../ui.js';
import { icon } from '../icons.js';
import { state } from '../core.js';
import { vehicleTitle } from '../format.js';
import { welcomeView } from '../views/vehicles.js';
import { moreView } from './more.js';
import { installView } from './install.js';
import { friendsScreen } from './friends.js';
import { settingsScreen, profileScreen, securityScreen } from './account.js';
import { adminScreen } from './admin.js';
import { homeScreen } from './home.js';
import { historyScreen } from './history.js';
import { garageScreen, detailScreen, sectionScreen } from './vehicles.js';

// Tabs: home, history, fill, vehicles, more.
const SECTIONS = new Set(['members', 'data', 'settings']);

const back = (href, label) => h('a', { class: 'm-back', href }, icon('back'), label);
const withBack = (href, label, view) => h('div', { class: 'm-screen' }, back(href, label), view);

const notFound = () => h('div', { class: 'panel empty' }, h('h1', {}, 'Not found'), h('p', {}, h('a', { href: '#/' }, 'Back to your dashboard')));

/** ctx: { parts, query, active, requests, friends, signOut } */
export async function screen({ parts, query, active, requests, friends, signOut }) {
  const [first = '', second, third] = parts;
  switch (first) {
    case '':
      if (active) return { redirect: `#/vehicles/${active.id}` };
      return { view: await welcomeView(), title: 'Welcome', tab: 'home' };
    case 'vehicles': {
      if (!second) return { redirect: '#/garage' };
      // Every vehicle the account belongs to, archived included, is in state.vehicles.
      const known = state.vehicles.find((x) => x.id === second);
      const name = known ? ` · ${vehicleTitle(known)}` : '';
      // Home and History make the vehicle the context; browsing its detail and sections does not.
      if (!third || third === 'stats') return { view: await homeScreen(second, { query, friends }), title: `Home${name}`, tab: 'home', vehicle: known };
      if (third === 'log') return { view: await historyScreen(second, query), title: `History${name}`, tab: 'history', vehicle: known };
      if (SECTIONS.has(third)) {
        const r = await sectionScreen(second, third);
        return { view: r.view, title: `${r.title} · ${vehicleTitle(r.vehicle)}`, tab: 'vehicles' };
      }
      // The detail hub at #/vehicles/:id/overview (the desktop's dashboard route); unknown sections land here too.
      return { view: await detailScreen(second, query, active), title: known ? vehicleTitle(known) : 'Vehicle', tab: 'vehicles' };
    }
    case 'garage':
      return { view: await garageScreen(query, active), title: 'Vehicles', tab: 'vehicles' };
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
