// More (phone shell only, route #/more): everything used weekly or less.
// Install (#/more/install) is a placeholder until the install guide lands.
import { get } from '../api.js';
import { h } from '../ui.js';
import { icon } from '../icons.js';
import { state } from '../core.js';
import { UNIT } from '../format.js';
import { themeControl } from '../theme.js';

const row = (href, ic, label, extra, sub) => h('li', {},
  h('a', { class: 'm-row', href }, icon(ic),
    h('span', { class: 'm-row-label' }, label, sub ? h('span', { class: 'm-row-sub' }, sub) : null),
    extra ?? null, icon('next', 'icon m-row-next')));

const group = (label, items) => h('nav', { class: 'm-group', 'aria-label': label }, h('ul', {}, items));

/** `requests`: incoming friend requests, for the count on the Friends row. */
export async function moreView({ requests = 0, onSignOut }) {
  const a = state.account ?? {};
  const who = a.displayName || a.email || '';
  const admin = a.instanceRole === 'admin';
  const p = state.prefs ?? {};
  const units = [UNIT[p.distanceUnit], UNIT[p.volumeUnit], p.currency].filter(Boolean).join(' · ');
  const version = await get('/v1/version').then((v) => v.server, () => null);
  const initials = who.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

  return h('div', { class: 'm-screen m-more' },
    h('h1', {}, 'More'),
    h('a', { class: 'm-profile', href: '#/settings/profile' },
      h('span', { class: 'm-avatar m-avatar-lg', 'aria-hidden': 'true' }, initials),
      h('span', { class: 'm-profile-text' }, h('strong', {}, a.displayName || a.email), h('span', {}, [a.displayName ? a.email : null, admin ? 'Administrator' : null].filter(Boolean).join(' · ') || 'Your profile')),
      icon('next', 'icon m-row-next')),
    group('More', [
      row('#/friends', 'users', 'Friends', requests
        ? h('span', { class: 'm-count' }, h('span', { 'aria-hidden': 'true' }, String(requests)), h('span', { class: 'm-vh' }, `(${requests} friend ${requests === 1 ? 'request' : 'requests'})`))
        : null),
      row('#/settings/preferences', 'sliders', 'Settings', units ? h('span', { class: 'm-row-meta' }, units) : null),
      row('#/settings/security', 'key', 'Account and security'),
      row('#/more/install', 'install', 'Install the app'),
    ]),
    admin ? group('Administration', [row('#/admin/users', 'shield', 'Administration', null, 'Accounts, invitations, units, email, sign-on, audit')]) : null,
    h('section', { class: 'm-group m-pad', 'aria-labelledby': 'm-theme-h' }, h('h2', { id: 'm-theme-h', class: 'm-label' }, 'Appearance'), themeControl()),
    h('dl', { class: 'm-group m-facts' },
      h('div', {}, h('dt', {}, 'Server'), h('dd', {}, location.host)),
      version ? h('div', {}, h('dt', {}, 'Version'), h('dd', {}, version)) : null),
    h('button', { type: 'button', class: 'danger m-wide', id: 'signout', onclick: onSignOut }, icon('logout'), 'Sign out'));
}

export function installView() {
  return h('div', { class: 'm-screen' },
    h('a', { class: 'm-back', href: '#/more' }, icon('back'), 'More'),
    h('h1', {}, 'Install the app'),
    h('div', { class: 'panel' },
      h('p', {}, 'DriveLoom can live on your home screen and open full screen, like an app.'),
      h('p', { class: 'muted' }, 'Step-by-step instructions for your phone will appear here soon. Meanwhile, use your browser’s menu: “Add to Home Screen” in Safari’s share menu, or “Install app” in Chrome.')));
}
