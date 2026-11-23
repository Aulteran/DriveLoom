// Service history on the phone (route #/vehicles/:id/service): the vehicle's
// visits newest first with item chips, a search and category filter, and a
// bottom sheet for adding or correcting a visit. Reached from the vehicle's
// detail screen and from More; the bottom tabs are unchanged. The list, form and
// rules are shared with the desktop page (views/service.js).
import { h, field, select, toast } from '../ui.js';
import { icon } from '../icons.js';
import { go, render, state } from '../core.js';
import { get } from '../api.js';
import { vehicleTitle, canAddService, canChangeVisit } from '../format.js';
import { FILTER_CATEGORIES, SERVICE_EMPTY, deleteVisit, loadVisits, moduleOn, plainDate, visitCard, visitForm } from '../views/service.js';
import { openSheet } from './sheet.js';
import { confirmSheet } from './confirm.js';

export async function serviceScreen(id, query) {
  const v = await get(`/v1/vehicles/${id}`);
  const back = h('a', { class: 'm-back', href: `#/vehicles/${v.id}/overview` }, icon('back'), vehicleTitle(v));
  const title = h('div', { class: 'm-title-text' }, h('h1', {}, 'Service'), h('p', { class: 'm-sub' }, vehicleTitle(v)));
  if (!moduleOn()) {
    return { vehicle: v, view: h('div', { class: 'm-screen m-stack' }, back, title, h('div', { class: 'm-card m-empty' }, h('p', {}, 'The Service module is not enabled on this server.'))) };
  }
  const filters = { q: query.get('q') ?? '', category: query.get('category') ?? '' };
  const filtered = Object.values(filters).some(Boolean);
  const canAdd = canAddService(v) && !v.archived;
  const first = await loadVisits(v, filters);

  const open = (existing) => {
    const sheet = openSheet({
      title: existing ? 'Edit service visit' : 'Add a service visit', sub: vehicleTitle(v), className: 'm-form-sheet',
      content: visitForm(v, existing, (changed) => { sheet.close(); if (changed) render(); }, { phone: true }),
    });
    sheet.dialog.querySelector('input:not([type=hidden]), select, textarea')?.focus();
  };
  const remove = async (visit) => {
    const gone = await confirmSheet({
      title: 'Delete this service visit?',
      message: `The visit of ${plainDate(visit.servicedOn)}${visit.provider ? ` at ${visit.provider}` : ''} and its ${visit.items.length} item${visit.items.length === 1 ? '' : 's'} are removed for every member of ${vehicleTitle(v)}.`,
      confirmLabel: 'Delete visit', action: () => deleteVisit(v, visit),
    });
    if (gone) { toast('Service visit deleted.'); render(); }
  };
  const card = (visit) => h('li', {}, visitCard(v, visit, { mayChange: !v.archived && canChangeVisit(v, visit, state.account.id), onEdit: open, onDelete: remove, phone: true }));
  const list = h('ul', { class: 'svc-list m-list-plain', 'aria-label': 'Service visits' }, first.items.map(card));
  let cursor = first.nextCursor;
  const more = h('button', { type: 'button', class: 'secondary m-wide', hidden: !cursor, onclick: async () => {
    more.disabled = true;
    try { const next = await loadVisits(v, filters, cursor); list.append(...next.items.map(card)); cursor = next.nextCursor; more.hidden = !cursor; } catch (e) { toast(e.message); } finally { more.disabled = false; }
  } }, 'Load more');

  const filterForm = h('form', { class: 'm-form', role: 'search', 'aria-label': 'Filter service visits', onsubmit: (e) => {
    e.preventDefault();
    const qs = new URLSearchParams(Object.entries(Object.fromEntries(new FormData(e.target))).filter(([, val]) => val));
    go(`#/vehicles/${v.id}/service${qs.size ? `?${qs}` : ''}`);
  } },
    field('Search', h('input', { name: 'q', type: 'search', value: filters.q, placeholder: 'Provider, item or note', maxlength: 100 })),
    field('Category', select('category', FILTER_CATEGORIES, filters.category)),
    h('button', { type: 'submit', class: 'secondary m-wide' }, 'Apply'),
    filtered ? h('a', { class: 'button ghost m-wide', href: `#/vehicles/${v.id}/service` }, 'Clear filters') : null);

  const empty = !first.items.length;
  return {
    vehicle: v,
    view: h('div', { class: 'm-screen m-stack' }, back, title,
      canAdd ? h('button', { type: 'button', class: 'm-wide', onclick: () => open(null) }, icon('plus'), 'Add service visit') : null,
      !empty || filtered ? filterForm : null,
      empty
        ? h('div', { class: 'm-card m-empty' }, h('span', { class: 'm-empty-art', 'aria-hidden': 'true' }, icon('wrench')), h('h2', {}, filtered ? 'No service visits match' : 'No service visits yet'),
          h('p', {}, filtered ? 'Try another search or category.' : SERVICE_EMPTY[0]), filtered ? null : h('p', { class: 'm-small m-muted' }, SERVICE_EMPTY[1]))
        : [list, more]),
  };
}
