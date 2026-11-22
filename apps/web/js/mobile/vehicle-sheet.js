// The active-vehicle switcher: a sheet opened from the header chip. The
// vehicle is context, not a place: it scopes Home, History and Fill up.
import { h } from '../ui.js';
import { icon } from '../icons.js';
import { state, rememberVehicle } from '../core.js';
import { vehicleTitle, vehicleDescription, ROLE } from '../format.js';
import { openSheet } from './sheet.js';

export const initial = (v) => (vehicleTitle(v).trim()[0] ?? '?').toUpperCase();

/** `onPick(vehicle)` runs after the choice is remembered and the sheet has closed. */
export function openVehicleSheet(current, onPick) {
  const list = state.vehicles.filter((v) => !v.archived || v.id === current?.id);
  let picked = null;
  const rows = list.map((v, i) => {
    const sel = v.id === current?.id;
    const sub = [vehicleTitle(v) === vehicleDescription(v) ? '' : vehicleDescription(v), ROLE[v.role]].filter(Boolean).join(' · ');
    return h('li', {}, h('button', {
      type: 'button', class: 'm-opt', 'aria-pressed': String(sel),
      onclick: () => { picked = v; sheet.close(); },
    },
    h('span', { class: 'm-avatar', dataset: { tone: String(i % 3) }, 'aria-hidden': 'true' }, initial(v)),
    h('span', { class: 'm-opt-text' }, h('span', { class: 'm-opt-name' }, vehicleTitle(v)), h('span', { class: 'm-opt-sub' }, v.archived ? `${sub} · archived` : sub)),
    sel ? icon('check', 'icon m-opt-check') : null));
  });
  const sheet = openSheet({
    title: 'Switch vehicle',
    content: [
      h('ul', { class: 'm-opts', 'aria-label': 'Vehicles' }, rows),
      h('div', { class: 'm-sheet-actions' },
        h('a', { class: 'button secondary', href: '#/garage' }, icon('garage'), 'Manage vehicles')),
    ],
    onClose: () => {
      if (!picked) return;
      rememberVehicle(picked.id);
      onPick(picked);
    },
  });
  // Start on the current choice, so Enter or Escape keeps it.
  sheet.dialog.querySelector('.m-opt[aria-pressed="true"]')?.focus();
  return sheet;
}
