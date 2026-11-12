// The garage: every vehicle the user is a member of, plus create and import.
import { get, post } from '../api.js';
import { h, form, field, select } from '../ui.js';
import { go, state } from '../main.js';
import { ROLE } from '../format.js';
import { icon } from '../icons.js';

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'INR', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'ZAR', 'BRL', 'MXN', 'SGD', 'HKD', 'AED'];
export const currencyOptions = (current) => [...new Set([current, ...CURRENCIES].filter(Boolean))].map((c) => [c, c]);

function card(v) {
  return h('a', { class: 'card', href: `#/vehicles/${v.id}` },
    h('div', { class: 'photo' }, v.imageVersion ? h('img', { src: `/v1/vehicles/${v.id}/image?v=${v.imageVersion}`, alt: '', loading: 'lazy' }) : icon('car')),
    h('div', { class: 'body' },
      h('div', { class: 'row spread' }, h('strong', {}, v.name), h('span', { class: `badge ${v.role === 'owner' ? 'accent' : ''}` }, ROLE[v.role])),
      h('div', { class: 'muted small' }, [v.year, v.make, v.model].filter(Boolean).join(' ') || '—', v.archived ? ' · archived' : '')));
}

export async function vehiclesView(query) {
  const archived = query.get('archived') === '1';
  const { items } = await get(`/v1/vehicles${archived ? '?includeArchived=true' : ''}`);
  const prefs = state.prefs;
  const create = form({ class: 'panel', hidden: items.length > 0 }, [
    h('h2', {}, 'Add a vehicle'),
    h('div', { class: 'grid' },
      field('Name', h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'Daily driver' })),
      field('Make', h('input', { name: 'make', maxlength: 80 })),
      field('Model', h('input', { name: 'model', maxlength: 80 })),
      field('Year', h('input', { name: 'year', type: 'number', min: 1886, max: new Date().getFullYear() + 2 })),
      field('Odometer unit', select('odometerUnit', [['km', 'Kilometres'], ['mi', 'Miles']], prefs.distanceUnit), 'What the car\'s own odometer shows.'),
      field('Reporting currency', select('currency', currencyOptions(prefs.currency), prefs.currency), 'Costs are totalled in this currency. It is fixed once costs are recorded.')),
    h('button', { type: 'submit' }, 'Add vehicle'),
  ], async (v) => {
    const created = await post('/v1/vehicles', { name: v.name, make: v.make || null, model: v.model || null, year: v.year ? Number(v.year) : null, odometerUnit: v.odometerUnit, currency: v.currency });
    go(`#/vehicles/${created.id}`);
  });
  const importBox = form({ class: 'panel', hidden: true }, [
    h('h2', {}, 'Import a vehicle'),
    h('p', { class: 'muted' }, 'Choose a DriveLoom JSON export from this or another instance. You become the owner of the new vehicle.'),
    field('Export file', h('input', { name: 'file', type: 'file', accept: '.json,application/json', required: true })),
    h('div', { class: 'row' }, h('button', { type: 'submit', name: 'mode', value: 'preview' }, 'Preview'), h('button', { type: 'submit', class: 'secondary', name: 'mode', value: 'commit' }, 'Import')),
    h('div', { class: 'report' }),
  ], async (_v, el, submitter) => {
    const file = el.querySelector('input[type=file]').files[0];
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error('That file is not valid JSON.'); }
    const r = await post('/v1/vehicle-imports', { data, dryRun: submitter?.value !== 'commit' });
    if (r.committed) { go(`#/vehicles/${r.vehicle.id}`); return `Imported ${r.summary.created} fill-ups.`; }
    el.querySelector('.report').replaceChildren(h('p', { class: 'notice' }, `Preview: ${r.summary.created} fill-ups would be imported, ${r.summary.invalid} invalid.`));
  });
  return h('div', {},
    h('div', { class: 'row spread', style: 'margin-bottom:16px' },
      h('h1', {}, 'Your vehicles'),
      h('div', { class: 'row' },
        h('button', { class: 'secondary', onclick: () => { importBox.hidden = !importBox.hidden; } }, icon('upload'), 'Import'),
        h('button', { onclick: () => { create.hidden = !create.hidden; create.querySelector('input')?.focus(); } }, icon('plus'), 'Add vehicle'))),
    create, importBox,
    items.length ? h('div', { class: 'grid' }, items.map(card)) : h('div', { class: 'panel empty' }, h('p', {}, 'No vehicles yet. Add one above, or ask an owner to share theirs with you.')),
    h('p', { class: 'small', style: 'margin-top:16px' }, h('a', { href: archived ? '#/' : '#/?archived=1' }, archived ? 'Hide archived vehicles' : 'Show archived vehicles')));
}
