// Service history (opt-in module): the vehicle's Service page on the desktop,
// plus the visit form, card and loader the phone screen (mobile/service.js)
// reuses. Money, odometer and cost stay strings; an empty cost field means
// "unknown" (sent as null) and a typed 0 means "known to be free".
import { get, post, patch, del } from '../api.js';
import { h, form, field, select, toast, confirmDialog } from '../ui.js';
import { go, render, state } from '../core.js';
import { date, money, qty, canAddService, canChangeVisit, vehicleTitle, localInput } from '../format.js';
import { icon } from '../icons.js';
import { attachmentsPanel, stagedAttachments, uploadStaged } from '../attachments.js';

/** Suggestions only: any text up to 120 characters is accepted. */
export const PRESETS = ['Oil change', 'Tyres rotated', 'Tyres replaced', 'Brake pads', 'Brake fluid', 'Air filter', 'Cabin filter', 'Battery', 'Spark plugs', 'Coolant', 'Wipers', 'Inspection', 'Alignment', 'Timing belt'];
export const CATEGORIES = [['scheduled', 'Scheduled'], ['repair', 'Repair'], ['inspection', 'Inspection'], ['other', 'Other']];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES);
export const FILTER_CATEGORIES = [['', 'Any category'], ...CATEGORIES];
const plainDate = (d) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
export { plainDate };

/** The page is reachable only with the module on; the personal preference merely hides the menu entry. */
export const moduleOn = () => !!state.modules?.service;

export async function loadVisits(v, f = {}, cursor = null) {
  const q = new URLSearchParams({ limit: '25' });
  for (const k of ['q', 'category', 'from', 'to']) if (f[k]) q.set(k, f[k]);
  if (cursor) q.set('cursor', cursor);
  return get(`/v1/vehicles/${v.id}/service-visits?${q}`);
}

let presetSeq = 0;

/** Add/edit form. `done(changed)` is called on save or cancel. */
export function visitForm(v, existing, done, { phone = false } = {}) {
  const listId = `svc-presets-${++presetSeq}`;
  const itemRows = h('div', { class: 'svc-items', role: 'group', 'aria-label': 'Work done' });
  const mkItem = (it) => {
    const row = h('div', { class: 'svc-item' },
      field('Item', h('input', { name: 'itemName', list: listId, maxlength: 120, required: true, autocomplete: 'off', value: it?.name ?? '', placeholder: 'Oil change' })),
      field('Category', select('itemCategory', CATEGORIES, it?.category ?? 'other')),
      field(`Cost (${v.currency}, optional)`, h('input', { name: 'itemCost', inputmode: 'decimal', pattern: '\\d+(\\.\\d+)?', value: it?.cost ?? '', placeholder: 'unknown' })),
      h('button', { type: 'button', class: 'ghost svc-remove', 'aria-label': 'Remove this item', onclick: () => { row.remove(); sync(); } }, icon('close')));
    row.dataset.notes = it?.notes ?? '';
    return row;
  };
  const sync = () => { for (const b of itemRows.querySelectorAll('.svc-remove')) b.hidden = itemRows.children.length < 2; };
  for (const it of existing?.items?.length ? existing.items : [null]) itemRows.append(mkItem(it));
  sync();
  const diy = h('input', { type: 'checkbox', name: 'diy', checked: existing?.diy ?? false });
  const provider = h('input', { name: 'provider', maxlength: 120, value: existing?.provider ?? '', autocomplete: 'off' });
  diy.addEventListener('change', () => { provider.placeholder = diy.checked ? 'Optional: where parts came from' : ''; });
  // A saved visit manages its files right away; a new one stages them until it exists.
  const staged = existing ? null : stagedAttachments({ phone });
  const attach = existing ? attachmentsPanel(v, existing, { mayChange: true, phone }) : staged.el;
  const el = form({ class: 'panel svc-form' }, [
    h('h2', {}, existing ? 'Edit service visit' : 'Add a service visit'),
    h('datalist', { id: listId }, PRESETS.map((p) => h('option', { value: p }))),
    h('div', { class: 'grid' },
      field('Date of service', h('input', { name: 'servicedOn', type: 'date', required: true, value: existing?.servicedOn ?? localInput().slice(0, 10) })),
      field('Odometer (optional)', h('div', { class: 'inline' },
        h('input', { name: 'odometer', inputmode: 'decimal', pattern: '\\d+(\\.\\d{1,3})?', 'aria-label': 'Odometer reading', value: existing?.odometer?.value ?? '' }),
        select('odometerUnit', [['km', 'km'], ['mi', 'mi']], existing?.odometer?.unit ?? v.odometerUnit, { 'aria-label': 'Odometer unit' })),
      'Not required, and never changes your fuel records.'),
      field('Provider (optional)', provider)),
    h('label', { class: 'check' }, diy, 'I did this myself (DIY)'),
    h('fieldset', { class: 'svc-fieldset' }, h('legend', {}, 'Work done'), itemRows,
      h('button', { type: 'button', class: 'secondary', onclick: () => { const r = mkItem(null); itemRows.append(r); sync(); r.querySelector('input')?.focus(); } }, icon('plus'), 'Add another item')),
    h('div', { class: 'grid' },
      field(`Total cost for the visit (${v.currency}, optional)`, h('input', { name: 'totalCost', inputmode: 'decimal', pattern: '\\d+(\\.\\d+)?', value: existing?.totalCost ?? '', placeholder: 'unknown' }),
        'Leave empty if unknown. Enter 0 if it was free.')),
    field('Notes', h('textarea', { name: 'notes', maxlength: 2000 }, existing?.notes ?? '')),
    attach,
    h('div', { class: 'row' }, h('button', { type: 'submit' }, existing ? 'Save changes' : 'Add visit'), h('button', { type: 'button', class: 'secondary', onclick: () => done(false) }, 'Cancel')),
  ], async (x) => {
    const items = [...itemRows.querySelectorAll('.svc-item')].map((r) => {
      const cost = r.querySelector('[name=itemCost]').value.trim();
      const notes = r.dataset.notes;
      return { name: r.querySelector('[name=itemName]').value.trim(), category: r.querySelector('[name=itemCategory]').value, cost: cost || null, ...(notes ? { notes } : {}) };
    });
    const odo = x.odometer.trim();
    const body = {
      servicedOn: x.servicedOn, odometer: odo ? { value: odo, unit: x.odometerUnit } : null, provider: x.provider.trim() || null,
      diy: x.diy === 'on', totalCost: x.totalCost.trim() || null, notes: x.notes.trim() || null, items,
    };
    if (existing) await patch(`/v1/vehicles/${v.id}/service-visits/${existing.id}`, body);
    let saved = existing;
    if (!existing) saved = await post(`/v1/vehicles/${v.id}/service-visits`, body);
    const failed = staged?.files.length ? await uploadStaged(v, saved.id, staged.files) : [];
    done(true);
    if (failed.length) { toast(`Visit added, but ${failed.length === 1 ? 'a file was' : `${failed.length} files were`} not attached: ${failed.join(' ')} Open the visit to try again.`); return undefined; }
    return existing ? 'Service visit updated.' : 'Service visit added.';
  });
  return el;
}

/** Cost of a visit as text: "Unknown" is distinct from a recorded zero. */
export const costText = (amount, currency) => (amount === null || amount === undefined ? 'Cost not recorded' : /^0(\.0+)?$/.test(amount) ? `${money(amount, currency)} (free)` : money(amount, currency));

export async function deleteVisit(v, visit) {
  await del(`/v1/vehicles/${v.id}/service-visits/${visit.id}`);
}

/** One visit as a card: date, provider/DIY, odometer, total, item chips, notes. */
export function visitCard(v, visit, { onEdit, onDelete, mayChange, phone = false }) {
  const title = `${plainDate(visit.servicedOn)}`;
  const meta = [visit.diy ? 'DIY' : null, visit.provider, visit.odometer ? `${qty(visit.display.odometer ?? visit.odometer)}` : null].filter(Boolean).join(' · ');
  return h('article', { class: 'panel svc-visit', 'aria-label': `Service visit on ${title}` },
    h('div', { class: 'svc-head' },
      h('div', {}, h('h2', {}, title), meta ? h('div', { class: 'muted small' }, meta) : null),
      h('div', { class: 'svc-total' }, visit.totalCost !== null ? h('strong', {}, costText(visit.totalCost, visit.currency)) : h('span', { class: 'muted small' }, 'Cost not recorded'))),
    h('ul', { class: 'svc-chips', 'aria-label': 'Work done' }, visit.items.map((i) => h('li', { class: 'svc-chip', 'data-category': i.category },
      h('span', {}, i.name),
      i.category !== 'other' ? h('span', { class: 'svc-chip-cat' }, CATEGORY_LABEL[i.category]) : null,
      i.cost !== null ? h('span', { class: 'svc-chip-cost' }, money(i.cost, visit.currency)) : null))),
    visit.notes ? h('p', { class: 'small muted svc-notes' }, visit.notes) : null,
    visit.attachments?.length || mayChange ? attachmentsPanel(v, visit, { mayChange, phone }) : null,
    mayChange ? h('div', { class: 'row' },
      h('button', { class: 'ghost', 'aria-label': `Edit service visit of ${title}`, onclick: () => onEdit(visit) }, 'Edit'),
      h('button', { class: 'ghost', 'aria-label': `Delete service visit of ${title}`, onclick: () => onDelete(visit) }, 'Delete')) : null);
}

export const SERVICE_EMPTY = ['Start from today. Adding past service is optional.', 'Record oil changes, tyres, brakes and repairs as they happen, with costs if you like.'];

// ---------- desktop page ----------
export async function serviceTab(v, query, pageHead, meta) {
  const head = (actions) => pageHead(vehicleTitle(v), 'Service', meta(v), actions);
  if (!moduleOn()) {
    return h('div', {}, head(), h('div', { class: 'panel empty' }, h('p', {}, 'The Service module is not enabled on this server.'), h('p', { class: 'small' }, 'An administrator can turn it on under Administration.')));
  }
  const canAdd = canAddService(v) && !v.archived;
  const filters = { q: query.get('q') ?? '', category: query.get('category') ?? '', from: query.get('from') ?? '', to: query.get('to') ?? '' };
  const filtered = Object.values(filters).some(Boolean);
  const first = await loadVisits(v, filters);
  const slot = h('div');
  const list = h('div', { class: 'svc-list' });
  const open = (existing) => {
    slot.replaceChildren(visitForm(v, existing, (changed) => { slot.replaceChildren(); if (changed) render(); }));
    slot.querySelector('input')?.focus();
  };
  const remove = async (visit) => {
    if (!(await confirmDialog(`Delete the service visit of ${plainDate(visit.servicedOn)}${visit.provider ? ` at ${visit.provider}` : ''}? This removes its ${visit.items.length} item${visit.items.length === 1 ? '' : 's'} for everyone with access.`, 'Delete'))) return;
    await deleteVisit(v, visit); toast('Service visit deleted.'); render();
  };
  const card = (visit) => visitCard(v, visit, { mayChange: !v.archived && canChangeVisit(v, visit, state.account.id), onEdit: open, onDelete: remove });
  list.append(...first.items.map(card));
  let cursor = first.nextCursor;
  const more = h('button', { type: 'button', class: 'secondary', hidden: !cursor, onclick: async () => {
    more.disabled = true;
    try { const next = await loadVisits(v, filters, cursor); list.append(...next.items.map(card)); cursor = next.nextCursor; more.hidden = !cursor; } catch (e) { toast(e.message); } finally { more.disabled = false; }
  } }, 'Load more');

  const filterForm = h('form', { class: 'row svc-filters', role: 'search', 'aria-label': 'Filter service visits', onsubmit: (e) => {
    e.preventDefault();
    const x = Object.fromEntries(new FormData(e.target));
    const qs = new URLSearchParams(Object.entries(x).filter(([, val]) => val));
    go(`#/vehicles/${v.id}/service${qs.size ? `?${qs}` : ''}`);
  } },
    field('Search', h('input', { name: 'q', type: 'search', value: filters.q, placeholder: 'Provider, item or note', maxlength: 100 })),
    field('Category', select('category', FILTER_CATEGORIES, filters.category)),
    field('From', h('input', { name: 'from', type: 'date', value: filters.from })),
    field('To', h('input', { name: 'to', type: 'date', value: filters.to })),
    h('button', { type: 'submit', class: 'secondary' }, 'Apply'),
    filtered ? h('a', { class: 'button ghost', href: `#/vehicles/${v.id}/service` }, 'Clear') : null);

  const addBtn = canAdd ? h('button', { onclick: () => open(null) }, icon('plus'), 'Add service visit') : null;
  const empty = !first.items.length;
  return h('div', {}, head(addBtn), slot,
    !empty || filtered ? filterForm : null,
    empty
      ? h('div', { class: 'panel empty' }, h('p', {}, filtered ? 'No service visits match these filters.' : SERVICE_EMPTY[0]), filtered ? null : h('p', { class: 'small' }, SERVICE_EMPTY[1]))
      : [list, h('div', { class: 'row center' }, more)]);
}
