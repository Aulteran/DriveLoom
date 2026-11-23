// "Reminders by email" on the Service page's Maintenance section (desktop page
// and phone screen). Every member gets their own "Email me about this vehicle"
// switch; the owner and managers also turn emails on for the vehicle, pick how
// often to repeat them and who receives them. Emails go through the
// administrator's SMTP settings only; without them, in-app reminders keep working.
import { get, put } from './api.js';
import { h, form, field, select, toast } from './ui.js';
import { icon } from './icons.js';

export const loadNotificationSettings = (v) => get(`/v1/vehicles/${v.id}/notification-settings`);

const ROLE = { owner: 'owner', editor: 'Authorized Manager', driver: 'driver' };
const CADENCE = [[0, 'Only once for each due point'], [1, 'Every day'], [3, 'Every 3 days'], [7, 'Every week'], [14, 'Every 2 weeks'], [30, 'Every 30 days'], [90, 'Every 90 days']];
const cadenceText = (n) => (n === 0 ? 'Each reminder is sent once.' : `While a task stays due, the reminder is repeated every ${n === 7 ? 'week' : `${n} day${n === 1 ? '' : 's'}`}.`);
const personName = (r) => r.displayName || r.email;

function myHint(s) {
  if (!s.me.eligible) return 'Viewers are not sent reminder emails. Reminders still show here.';
  if (s.me.optedOut) return 'You have turned off reminder emails for this vehicle.';
  if (!s.me.selected) return 'You are not on this vehicle\'s email list. The owner or a manager can add you.';
  if (!s.emailEnabled) return 'You will get emails once the owner or a manager turns them on.';
  return 'You get an email when a task becomes due soon or overdue.';
}

/** The settings form for the owner and managers. `done(changed)` closes it. */
export function notificationSettingsForm(v, s, done) {
  const cadence = CADENCE.some(([n]) => n === s.followUpDays) ? CADENCE : [...CADENCE, [s.followUpDays, `Every ${s.followUpDays} days`]];
  const people = s.recipients.map((r) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', name: 'recipient', value: r.userId, checked: r.selected, disabled: r.implicit }),
    `${personName(r)} (${ROLE[r.role] ?? r.role})${r.implicit ? ', always included' : ''}${r.optedOut ? ', has turned off their emails' : ''}`));
  return form({ class: 'panel mt-form' }, [
    h('h2', {}, 'Reminder email settings'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', role: 'switch', name: 'emailEnabled', checked: s.emailEnabled }), 'Send reminder emails for this vehicle'),
    field('Repeat while a task stays due', select('followUpDays', cadence.map(([n, label]) => [String(n), label]), String(s.followUpDays)),
      `"Due soon" means within ${s.leadDays} days or ${s.leadDistance.value} ${s.leadDistance.unit}. One email groups every task that needs a reminder.`),
    h('fieldset', { class: 'svc-fieldset' }, h('legend', {}, 'Who gets the emails'), people,
      h('p', { class: 'small muted' }, 'Viewers are never sent emails. Anyone can turn off their own emails, and choosing them here does not override that.')),
    h('div', { class: 'row' }, h('button', { type: 'submit' }, 'Save email settings'), h('button', { type: 'button', class: 'secondary', onclick: () => done(false) }, 'Cancel')),
  ], async (x, el) => {
    const recipientUserIds = [...el.querySelectorAll('input[name=recipient]:checked')].map((i) => i.value);
    await put(`/v1/vehicles/${v.id}/notification-settings`, { emailEnabled: !!x.emailEnabled, followUpDays: Number(x.followUpDays), recipientUserIds });
    done(true);
    return 'Email settings saved.';
  });
}

/** The panel. `present(title, build)` shows the settings form (inline on the desktop, a sheet on phones). */
export function notificationPanel(v, s, { phone = false, present, refresh }) {
  const id = phone ? 'nt-me-m' : 'nt-me-d';
  const hint = h('p', { id: `${id}-d`, class: phone ? 'm-small m-muted' : 'small muted' }, myHint(s));
  const sw = h('input', { id, type: 'checkbox', role: 'switch', class: phone ? 'm-toggle' : '', checked: !s.me.optedOut, disabled: v.archived, 'aria-describedby': `${id}-d`, onchange: async (e) => {
    const on = e.target.checked;
    try {
      const next = await put(`/v1/vehicles/${v.id}/notification-preferences/me`, { emailMe: on });
      hint.textContent = myHint(next);
      toast(on ? 'You will get reminder emails for this vehicle.' : 'Reminder emails turned off for you.');
    } catch (err) { e.target.checked = !on; toast(err.message); }
  } });
  const mine = phone
    ? h('div', { class: 'm-switch-row' }, h('label', { for: id }, 'Email me about this vehicle'), sw)
    : h('label', { class: 'check', for: id }, sw, 'Email me about this vehicle');
  const d = s.delivery;
  return h('section', { class: phone ? 'm-card m-pad m-stack-s nt-panel' : 'panel nt-panel', 'aria-labelledby': `${id}-h` },
    h('h2', { id: `${id}-h` }, 'Reminders by email'),
    h('p', {}, s.emailEnabled ? `Reminder emails are on for this vehicle. ${cadenceText(s.followUpDays)}` : 'Reminder emails are off for this vehicle.'),
    s.smtpConfigured ? null : h('p', { class: `${phone ? 'm-small' : 'small'} mt-note` }, icon('alert'), 'Ask your administrator to configure email; in-app reminders keep working.'),
    mine, hint,
    d ? h('p', { class: phone ? 'm-small m-muted' : 'small muted' },
      `Last email sent: ${d.lastSentAt ? new Date(d.lastSentAt).toLocaleString() : 'none yet'}. Waiting to be sent: ${d.pending}.${d.failed ? ` Could not be sent: ${d.failed}.` : ''}`) : null,
    s.canManage && !v.archived ? h('button', { type: 'button', class: phone ? 'secondary m-wide' : 'secondary', onclick: () => present('Reminder email settings', (close) => notificationSettingsForm(v, s, (changed) => { close(); if (changed) refresh(); })) }, 'Change email settings') : null,
    h('p', { class: phone ? 'm-small m-muted' : 'small muted' }, 'Snoozing a task mutes its reminders, emails included. DriveLoom is not a substitute for your manufacturer\'s or mechanic\'s guidance.'));
}
