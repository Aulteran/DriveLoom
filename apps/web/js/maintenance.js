// Maintenance planning on the Service page (shared by the desktop page and the
// phone screen): task list with status, add/edit form, snooze dialog and the
// "mark done" shortcut. DriveLoom ships no manufacturer schedules, so every
// interval here was typed by a person. Status is computed by the server; this
// file only presents it, never recomputes or estimates mileage. Dates are plain
// YYYY-MM-DD strings; odometers are decimal strings with their unit.
import { get, post, patch, put, del } from './api.js';
import { h, form, field, select, toast } from './ui.js';
import { icon } from './icons.js';
import { plainDate } from './format.js';

export const loadMaintenance = async (v) => {
  const [tasks, summary, catalog] = await Promise.all([
    get(`/v1/vehicles/${v.id}/maintenance-tasks`), get(`/v1/vehicles/${v.id}/maintenance-status`), get('/v1/maintenance-catalog'),
  ]);
  return { tasks: tasks.items, summary, catalog };
};
/** Every task including archived ones, for the visit form's "Completes maintenance task" choice. */
export const loadTaskChoices = async (v) => (await get(`/v1/vehicles/${v.id}/maintenance-tasks?includeArchived=true`)).items;

const STATE = {
  overdue: { icon: 'alert', label: 'Overdue', cls: 'bad' },
  due_soon: { icon: 'clock', label: 'Due soon', cls: 'warn' },
  ok: { icon: 'check', label: 'On track', cls: 'good' },
  no_baseline: { icon: 'list', label: 'No starting point', cls: '' },
  unknown_reading: { icon: 'gauge', label: 'Odometer needed', cls: '' },
  completed: { icon: 'check', label: 'Done', cls: 'good' },
};
/** Status as icon plus words: colour is never the only signal. */
export const statusBadge = (state) => { const s = STATE[state] ?? STATE.no_baseline; return h('span', { class: `badge mt-badge ${s.cls}` }, icon(s.icon), s.label); };

const num = (n) => Number(n).toLocaleString();
const dist = (d) => (d ? `${num(d.value)} ${d.unit}` : '');
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const inMonth = () => { const d = new Date(); d.setMonth(d.getMonth() + 1); return ymd(d); };

export function scheduleText(t) {
  if (!t.recurring) return 'One-time';
  const parts = [];
  if (t.intervalDays) parts.push(`${t.intervalDays} day${t.intervalDays === 1 ? '' : 's'}`);
  if (t.intervalDistance) parts.push(dist(t.intervalDistance));
  return `Repeats every ${parts.join(' or ')}${parts.length > 1 ? ', whichever comes first' : ''}`;
}

/** The lines under a task's name, each a short sentence. Never claims live mileage. */
export function dueLines(t, summary) {
  const out = [];
  if (t.status === 'completed') { out.push(`Done${t.lastCompleted ? ` on ${plainDate(t.lastCompleted.servicedOn)}` : ''}.`); return out; }
  if (t.status === 'no_baseline') {
    out.push(t.distanceBaselineMissing
      ? 'The last completion has no odometer reading, so the next distance cannot be worked out.'
      : 'No starting point yet. Record a visit that completes this task, or set a first due date or odometer.');
    return out;
  }
  const due = [];
  if (t.dueOn) due.push(plainDate(t.dueOn));
  if (t.dueOdometer) due.push(`at ${dist(t.dueOdometer)}`);
  out.push(`Due ${due.join(' or ')}${t.baseline === 'first_due' ? ' (first due point you set)' : ''}.`);
  if (t.daysUntilDue !== null) out.push(t.daysUntilDue < 0 ? `${-t.daysUntilDue} day${t.daysUntilDue === -1 ? '' : 's'} past the date.` : t.daysUntilDue === 0 ? 'Due today.' : `${t.daysUntilDue} day${t.daysUntilDue === 1 ? '' : 's'} to go.`);
  if (t.dueOdometer) {
    const r = summary?.reading;
    if (!r) out.push('No odometer reading is known yet, so the distance cannot be checked.');
    else if (t.distanceUntilDue) {
      const left = Number(t.distanceUntilDue.value);
      out.push(`${left < 0 ? `${num(-left)} ${t.distanceUntilDue.unit} past the odometer` : `${num(left)} ${t.distanceUntilDue.unit} to go`}, as of the ${dist(r.odometer)} reading on ${plainDate(r.on)}.`);
    }
    if (t.readingStale) out.push('That reading is old; DriveLoom does not estimate mileage since. Add a fill-up or visit with an odometer to refresh it.');
  }
  return out;
}

function snoozeText(t) {
  if (!t.snoozed) return null;
  const s = t.snoozed;
  const end = [s.until ? `until ${plainDate(s.until)}` : null, s.untilOdometer ? `until the odometer passes ${dist(s.untilOdometer)}` : null].filter(Boolean).join(' or ');
  return `Reminders muted ${s.scope === 'vehicle' ? 'for everyone' : 'for you'} ${end}${s.reason ? ` (${s.reason})` : ''}. The task is still ${STATE[t.status].label.toLowerCase()}.`;
}

function summaryStrip(summary, phone) {
  const c = summary.counts, r = summary.reading, d = summary.defaults;
  const bits = [['overdue', c.overdue, 'overdue'], ['due_soon', c.due_soon, 'due soon'], ['ok', c.ok + c.completed, 'on track'], ['no_baseline', c.no_baseline, 'without a starting point'], ['unknown_reading', c.unknown_reading, 'needing an odometer reading']]
    .filter(([, n]) => n > 0).map(([k, n, label]) => h('li', { class: 'mt-count' }, statusBadge(k), `${n} ${label}`));
  return h('section', { class: `${phone ? 'm-card ' : 'panel '}mt-summary`, 'aria-label': 'Maintenance summary' },
    bits.length ? h('ul', { class: 'mt-counts' }, bits) : h('p', { class: 'muted' }, c.total ? 'Nothing needs attention right now.' : 'No tasks yet.'),
    h('p', { class: 'small muted' }, r ? `Latest odometer reading: ${dist(r.odometer)} on ${plainDate(r.on)} (from ${r.source === 'fuel' ? 'a fill-up' : 'a service visit'})${r.stale ? `, which is older than ${d.staleReadingDays} days` : ''}.` : 'No odometer reading yet. Distance-based tasks need a fill-up or a service visit with an odometer.'),
    h('p', { class: 'small muted' }, `"Due soon" means within ${d.leadDays} days or ${dist(d.leadDistance)}. These are illustrative defaults, not manufacturer guidance.`));
}

export function taskCard(v, t, summary, a) {
  const lines = dueLines(t, summary);
  const sn = snoozeText(t);
  const last = t.lastCompleted ? `Last done ${plainDate(t.lastCompleted.servicedOn)}${t.lastCompleted.odometer ? ` at ${dist(t.lastCompleted.odometer)}` : ''}.` : 'Not recorded as done yet.';
  return h('article', { class: `${a.phone ? 'm-card ' : 'panel '}mt-task`, 'aria-label': `Maintenance task ${t.name}` },
    h('div', { class: 'mt-head' }, h('h3', {}, t.name), statusBadge(t.status)),
    h('p', { class: 'small muted' }, scheduleText(t)),
    h('div', { class: 'mt-due' }, lines.map((l) => h('p', { class: 'small' }, l))),
    h('p', { class: 'small muted' }, last),
    sn ? h('p', { class: 'small mt-snooze' }, icon('history'), sn) : null,
    t.notes ? h('p', { class: 'small muted svc-notes' }, t.notes) : null,
    h('div', { class: 'row mt-actions' },
      a.mayRecord && t.status !== 'completed' ? h('button', { type: 'button', 'aria-label': `Mark done: ${t.name}`, onclick: () => a.onDone(t) }, icon('check'), 'Mark done') : null,
      a.maySnooze ? h('button', { type: 'button', class: 'secondary', 'aria-label': `Snooze reminders for ${t.name}`, onclick: () => a.onSnooze(t) }, 'Snooze') : null,
      a.mayManage ? h('button', { type: 'button', class: 'ghost', 'aria-label': `Edit ${t.name}`, onclick: () => a.onEdit(t) }, 'Edit') : null,
      a.mayManage ? h('button', { type: 'button', class: 'ghost', 'aria-label': `Archive ${t.name}`, onclick: () => a.onArchive(t) }, 'Archive') : null,
      a.mayManage ? h('button', { type: 'button', class: 'ghost', 'aria-label': `Delete ${t.name}`, onclick: () => a.onDelete(t) }, 'Delete') : null));
}

/** Add / edit form. `done(changed)` closes the form. */
export function taskForm(v, existing, catalog, done) {
  const catalogSel = select('catalog', [['', 'Custom (type your own)'], ...catalog.items.map((c) => [c.key, c.name])], existing?.catalogKey ?? '');
  const name = h('input', { name: 'name', maxlength: 120, required: true, autocomplete: 'off', value: existing?.name ?? '', placeholder: 'Oil change' });
  catalogSel.addEventListener('change', () => { const c = catalog.items.find((i) => i.key === catalogSel.value); if (c) name.value = c.name; });
  const recurring = select('recurring', [['true', 'Repeats on a schedule'], ['false', 'One-time']], String(existing?.recurring ?? true));
  const days = h('input', { name: 'intervalDays', type: 'number', min: 1, max: 36500, step: 1, inputmode: 'numeric', value: existing?.intervalDays ?? '', placeholder: 'e.g. 365' });
  const unit = (n, val) => select(n, [['km', 'km'], ['mi', 'mi']], val ?? v.odometerUnit, { 'aria-label': `${n === 'intervalUnit' ? 'Interval' : 'Odometer'} unit` });
  const repeatBox = h('div', { class: 'grid' },
    field('Every how many days (optional)', days, '365 days is about a year. Leave empty for a distance-only task.'),
    field('Every how far (optional)', h('div', { class: 'inline' }, h('input', { name: 'intervalDistance', inputmode: 'decimal', pattern: '\\d+(\\.\\d{1,3})?', 'aria-label': 'Interval distance', value: existing?.intervalDistance?.value ?? '' }), unit('intervalUnit', existing?.intervalDistance?.unit)),
      'If you set both, the task is due when either is reached first.'));
  const sync = () => { repeatBox.hidden = recurring.value !== 'true'; };
  recurring.addEventListener('change', sync); sync();
  return form({ class: 'panel mt-form' }, [
    h('h2', {}, existing ? 'Edit maintenance task' : 'Add a maintenance task'),
    h('p', { class: 'small muted' }, 'Use your owner\'s manual or your mechanic\'s guidance for the numbers. DriveLoom does not suggest intervals.'),
    h('div', { class: 'grid' }, field('Common service types', catalogSel, 'Just a name to start from.'), field('Task name', name)),
    field('Schedule', recurring),
    repeatBox,
    h('div', { class: 'grid' },
      field('First due on (optional)', h('input', { name: 'firstDueOn', type: 'date', value: existing?.firstDueOn ?? '' }), 'Used until the task is first recorded as done.'),
      field('First due at odometer (optional)', h('div', { class: 'inline' }, h('input', { name: 'firstDueOdometer', inputmode: 'decimal', pattern: '\\d+(\\.\\d{1,3})?', 'aria-label': 'First due odometer', value: existing?.firstDueOdometer?.value ?? '' }), unit('firstUnit', existing?.firstDueOdometer?.unit)))),
    field('Notes (optional)', h('textarea', { name: 'notes', maxlength: 500 }, existing?.notes ?? '')),
    h('div', { class: 'row' }, h('button', { type: 'submit' }, existing ? 'Save changes' : 'Add task'), h('button', { type: 'button', class: 'secondary', onclick: () => done(false) }, 'Cancel')),
  ], async (x) => {
    const rec = x.recurring === 'true';
    const iv = x.intervalDistance.trim(), fo = x.firstDueOdometer.trim(), d = String(x.intervalDays ?? '').trim();
    const body = {
      name: x.name.trim(), catalogKey: x.catalog || null, recurring: rec,
      intervalDays: rec && d ? Number(d) : null, intervalDistance: rec && iv ? { value: iv, unit: x.intervalUnit } : null,
      firstDueOn: x.firstDueOn || null, firstDueOdometer: fo ? { value: fo, unit: x.firstUnit } : null, notes: x.notes.trim() || null,
    };
    if (existing) await patch(`/v1/vehicles/${v.id}/maintenance-tasks/${existing.id}`, body); else await post(`/v1/vehicles/${v.id}/maintenance-tasks`, body);
    done(true);
    return existing ? 'Task updated.' : 'Task added.';
  });
}

/** Snooze dialog: presets, scope, reason, and clearing. Snoozing only mutes reminders. */
export function snoozeForm(v, t, summary, { mayVehicle }, done) {
  const hasReading = !!summary.reading;
  const date = h('input', { name: 'date', type: 'date', min: inDays(0), 'aria-label': 'Snooze until date' });
  const extra = h('input', { name: 'extra', inputmode: 'decimal', pattern: '\\d+(\\.\\d{1,3})?', 'aria-label': 'Additional distance', disabled: !hasReading });
  const target = h('input', { name: 'target', inputmode: 'decimal', pattern: '\\d+(\\.\\d{1,3})?', 'aria-label': 'Odometer to snooze until' });
  const mk = (id, label, extraEl, disabled = false, hint = null) => h('div', { class: 'mt-preset' },
    h('label', { class: 'check' }, h('input', { type: 'radio', name: 'preset', value: id, checked: id === 'week', disabled }), label), extraEl, hint ? h('p', { class: 'small muted' }, hint) : null);
  const clear = async (scope) => { await del(`/v1/vehicles/${v.id}/maintenance-tasks/${t.id}/snooze?scope=${scope}`); done(true); toast('Snooze cleared.'); };
  const mine = t.snoozes.find((s) => s.scope === 'personal'), shared = t.snoozes.find((s) => s.scope === 'vehicle');
  return form({ class: 'panel mt-form' }, [
    h('h2', {}, `Snooze ${t.name}`),
    h('p', { class: 'small' }, 'Snoozing only mutes reminders. It does not move the due point, mark the task done or make it safe to put off; an overdue task stays overdue.'),
    h('fieldset', { class: 'svc-fieldset' }, h('legend', {}, 'Snooze for'),
      mk('week', '1 week'), mk('month', '1 month'),
      mk('date', 'Until a date', date),
      mk('distance', 'For some more distance', h('div', { class: 'inline' }, extra, select('extraUnit', [['km', 'km'], ['mi', 'mi']], v.odometerUnit, { 'aria-label': 'Additional distance unit', disabled: !hasReading })), !hasReading,
        hasReading ? 'Counted from the latest odometer reading, once, when you save.' : 'Needs an odometer reading first: add a fill-up or a service visit with an odometer.'),
      mk('odometer', 'Until the odometer reaches', h('div', { class: 'inline' }, target, select('targetUnit', [['km', 'km'], ['mi', 'mi']], v.odometerUnit, { 'aria-label': 'Odometer unit' })))),
    mayVehicle ? h('fieldset', { class: 'svc-fieldset' }, h('legend', {}, 'Who is it for'),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'scope', value: 'personal', checked: true }), 'Just me'),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'scope', value: 'vehicle' }), 'Everyone with this vehicle')) : h('p', { class: 'small muted' }, 'This mutes reminders for you only.'),
    field('Reason (optional)', h('input', { name: 'reason', maxlength: 200, autocomplete: 'off', placeholder: 'e.g. booked for next month' })),
    h('div', { class: 'row' }, h('button', { type: 'submit' }, 'Snooze'), h('button', { type: 'button', class: 'secondary', onclick: () => done(false) }, 'Cancel'),
      mine ? h('button', { type: 'button', class: 'ghost', onclick: () => clear('personal').catch((e) => toast(e.message)) }, 'Clear my snooze') : null,
      shared && mayVehicle ? h('button', { type: 'button', class: 'ghost', onclick: () => clear('vehicle').catch((e) => toast(e.message)) }, 'Clear for everyone') : null),
  ], async (x) => {
    const body = {};
    if (x.reason.trim()) body.reason = x.reason.trim();
    if (x.preset === 'week') body.until = inDays(7);
    else if (x.preset === 'month') body.until = inMonth();
    else if (x.preset === 'date') { if (!x.date) throw new Error('Pick a date.'); body.until = x.date; }
    else if (x.preset === 'distance') { if (!x.extra.trim()) throw new Error('Enter how much more distance.'); body.additionalDistance = { value: x.extra.trim(), unit: x.extraUnit }; }
    else { if (!x.target.trim()) throw new Error('Enter an odometer reading.'); body.untilOdometer = { value: x.target.trim(), unit: x.targetUnit }; }
    await put(`/v1/vehicles/${v.id}/maintenance-tasks/${t.id}/snooze?scope=${mayVehicle && x.scope === 'vehicle' ? 'vehicle' : 'personal'}`, body);
    done(true);
    return 'Reminders snoozed. The task is not rescheduled.';
  });
}

export const MAINT_EMPTY = ['Add what you want to keep track of.', 'DriveLoom does not ship manufacturer schedules. Use your owner\'s manual or your mechanic\'s guidance for the intervals.'];

/**
 * The whole Maintenance section. `present(title, build)` shows a form (inline on
 * the desktop, a sheet on phones); `build(close)` returns its node. `openVisit(prefill)`
 * opens the add-visit form; `refresh()` redraws the page.
 */
export function maintenancePanel(v, data, { phone = false, present, openVisit, refresh, mayRecord, mayManage, maySnooze, confirm }) {
  const { tasks, summary, catalog } = data;
  const actions = {
    phone, mayRecord, mayManage, maySnooze,
    onDone: (t) => openVisit({ items: [{ name: t.name, category: 'scheduled', taskId: t.id }] }),
    onSnooze: (t) => present(`Snooze ${t.name}`, (close) => snoozeForm(v, t, summary, { mayVehicle: mayManage }, (changed) => { close(); if (changed) refresh(); })),
    onEdit: (t) => present('Edit maintenance task', (close) => taskForm(v, t, catalog, (changed) => { close(); if (changed) refresh(); })),
    onArchive: async (t) => { await patch(`/v1/vehicles/${v.id}/maintenance-tasks/${t.id}`, { archived: true }); toast(`${t.name} archived. Its history is kept.`); refresh(); },
    onDelete: async (t) => {
      if (!(await confirm(`Delete the task "${t.name}"? Service items that completed it are kept but no longer linked. This is removed for everyone with access.`, 'Delete task'))) return;
      await del(`/v1/vehicles/${v.id}/maintenance-tasks/${t.id}`); toast('Task deleted.'); refresh();
    },
  };
  const guard = (fn) => (t) => fn(t)?.catch?.((e) => toast(e.message));
  for (const k of ['onArchive', 'onDelete']) actions[k] = guard(actions[k]);
  const add = mayManage ? h('button', { type: 'button', class: phone ? 'm-wide' : '', onclick: () => present('Add a maintenance task', (close) => taskForm(v, null, catalog, (changed) => { close(); if (changed) refresh(); })) }, icon('plus'), 'Add maintenance task') : null;
  const list = h('ul', { class: 'svc-list m-list-plain', 'aria-label': 'Maintenance tasks' }, tasks.map((t) => h('li', {}, taskCard(v, t, summary, actions))));
  return {
    add,
    node: h('div', { class: phone ? 'm-stack' : '' }, summaryStrip(summary, phone),
      tasks.length ? list : h('div', { class: phone ? 'm-card m-empty' : 'panel empty' }, h('p', {}, MAINT_EMPTY[0]), h('p', { class: 'small' }, MAINT_EMPTY[1]))),
  };
}
