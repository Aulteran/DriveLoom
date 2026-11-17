// The garage (every vehicle the user is a member of, plus create and import)
// and the first-run welcome screen shown before any vehicle exists.
import { post } from '../api.js';
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

function createForm(hidden) {
  const prefs = state.prefs;
  return form({ class: 'panel', hidden }, [
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
}

function importForm(hidden) {
  return form({ class: 'panel', hidden }, [
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
}

export const pageHead = (eyebrow, title, sub, actions) => h('header', { class: 'page-head' },
  h('div', {}, eyebrow ? h('div', { class: 'eyebrow' }, eyebrow) : null, h('h1', {}, title), sub ? h('p', { class: 'muted' }, sub) : null),
  actions ? h('div', { class: 'row' }, actions) : null);

export async function garageView(query) {
  const archived = query.get('archived') === '1';
  // main.js has just loaded every vehicle, archived included.
  const items = state.vehicles.filter((v) => archived || !v.archived);
  const create = createForm(true);
  const importBox = importForm(true);
  return h('div', {},
    pageHead('Account', 'Garage', 'Every vehicle you own or that is shared with you.', [
      h('button', { class: 'secondary', onclick: () => { importBox.hidden = !importBox.hidden; } }, icon('upload'), 'Import'),
      h('button', { onclick: () => { create.hidden = !create.hidden; create.querySelector('input')?.focus(); } }, icon('plus'), 'Add vehicle')]),
    create, importBox,
    items.length ? h('div', { class: 'grid' }, items.map(card)) : h('div', { class: 'panel empty' }, h('p', {}, 'No vehicles yet. Add one above, or ask an owner to share theirs with you.')),
    h('p', { class: 'small', style: 'margin-top:16px' }, h('a', { href: archived ? '#/garage' : '#/garage?archived=1' }, archived ? 'Hide archived vehicles' : 'Show archived vehicles')));
}

export async function welcomeView() {
  const hasArchived = state.vehicles.length > 0;
  const steps = [['car', 'Add your vehicle', 'Name it and pick the units its odometer shows.'], ['fuel', 'Log fill-ups', 'Odometer, fuel and cost at each stop.'], ['chart', 'Watch the trends', 'Economy, spending and distance appear on your dashboard.']];
  const importBox = importForm(true);
  return h('div', { class: 'welcome' },
    pageHead('Get started', 'Welcome to DriveLoom', 'Your dashboard fills with charts and reports once a vehicle has a few fill-ups.'),
    h('ol', { class: 'steps' }, steps.map(([ic, t, d], i) => h('li', { class: 'step' }, h('span', { class: 'step-n' }, icon(ic)), h('div', {}, h('strong', {}, `${i + 1}. ${t}`), h('div', { class: 'small muted' }, d))))),
    createForm(false),
    h('p', { class: 'small' },
      h('button', { type: 'button', class: 'ghost', onclick: () => { importBox.hidden = !importBox.hidden; } }, icon('upload'), 'Import a vehicle from a DriveLoom export instead'),
      hasArchived ? [' · ', h('a', { href: '#/garage?archived=1' }, 'See archived vehicles')] : null),
    importBox,
    h('p', { class: 'small muted' }, 'Someone already tracking a car can share it with you from its Members page.'));
}
