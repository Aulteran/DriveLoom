// Quick fill-up: the centre tab of the phone shell, route #/fill.
//
// HOOK FOR THE NEXT CHUNK. The shell calls openFillUp({ vehicle, onClose })
// when the route is #/fill, after Home has rendered underneath. Replace the
// placeholder body below with the real form; keep the signature:
//   - vehicle: the active vehicle (from GET /v1/vehicles), or null when the
//     account has none. Its id, odometerUnit and currency scope the form.
//   - onClose(): call exactly once when the sheet goes away (saved or not);
//     the shell then returns to the screen the person came from.
// Values typed into the form must stay strings end to end (see apps/api
// openapi: decimals are strings). openSheet({ size: 'full' }) gives the
// full-height sheet the design asks for.
import { h } from '../ui.js';
import { icon } from '../icons.js';
import { vehicleTitle } from '../format.js';
import { openSheet } from './sheet.js';

export function openFillUp({ vehicle, onClose } = {}) {
  const content = vehicle
    ? [
      h('p', { class: 'm-sheet-sub' }, vehicleTitle(vehicle)),
      h('ol', { class: 'm-plan' },
        ['Odometer', 'Fuel volume', 'Amount paid', 'Full tank', 'Date and time'].map((t) => h('li', {}, t))),
      h('p', { class: 'muted small' }, 'The quick fill-up form arrives here next. Until then, use the fuel log.'),
      vehicle.role !== 'viewer' && !vehicle.archived
        ? h('a', { class: 'button m-wide', href: `#/vehicles/${vehicle.id}/log?add=1` }, icon('fuel'), 'Open the fuel log form')
        : h('p', { class: 'muted small' }, 'You can view this vehicle but not add fill-ups to it.'),
    ]
    : [h('p', {}, 'Add a vehicle first, then log its fill-ups here.'), h('a', { class: 'button m-wide', href: '#/garage' }, icon('car'), 'Go to Vehicles')];
  return openSheet({ title: 'Add a fill-up', size: 'full', content, onClose });
}
