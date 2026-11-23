// Vehicles on the phone: the garage (#/garage), a vehicle's detail hub
// (#/vehicles/:id/overview, the desktop dashboard's route) and its sections
// as list rows and sheets: members, import and export, vehicle settings
// (#/vehicles/:id/members|data|settings). Forms reuse the desktop's create
// and import logic; every change goes through the same API calls.
import { makeModelFields } from '../identity.js';
import { api, get, post, put, patch, del } from '../api.js';
import { h, form, field, select, toast, download } from '../ui.js';
import { icon } from '../icons.js';
import { state, go, render, rememberVehicle, forgetVehicle, serviceVisible } from '../core.js';
import { qty, money, date, UNIT, ROLE, GRANTABLE_ROLES, ROLE_HELP, vehicleTitle, vehicleDescription, vehicleLabel, canEditVehicle } from '../format.js';
import { Dec, lowerIsBetter } from '../economy.js';
import { DAY, statsUrl, lastMonths, compactMoney } from '../views/vehicle.js';
import { createForm, importForm, currencyOptions } from '../views/vehicles.js';
import { barChart } from '../views/chart.js';
import { openSheet } from './sheet.js';
import { confirmSheet } from './confirm.js';
import { initial } from './vehicle-sheet.js';
import { touchEconomyChart } from './chart.js';
import { periodControl } from './home.js';
import { PERIODS } from './history.js';
import { glyph } from './glyph.js';

const unitText = (u) => UNIT[u] ?? u;
const back = (href, label) => h('a', { class: 'm-back', href }, icon('back'), label);
const detailHref = (v) => `#/vehicles/${v.id}/overview`;
const describe = (v) => [vehicleTitle(v) === vehicleDescription(v) ? '' : vehicleDescription(v), ROLE[v.role]].filter(Boolean).join(' · ');
const avatar = (v, i) => h('span', { class: 'm-avatar', dataset: { tone: String(i % 3) }, 'aria-hidden': 'true' }, initial(v));

/** A form inside a sheet: the desktop form, without its own panel heading. */
function formSheet(title, content, sub) {
  const sheet = openSheet({ title, sub, className: 'm-form-sheet', content });
  sheet.dialog.querySelector('input:not([type=hidden]), select, textarea')?.focus();
  return sheet;
}

// ---------- garage ----------
export async function garageScreen(query, active) {
  // One request gives every non-archived vehicle's 90-day average.
  const cmp = await get('/v1/comparisons?window=90d').catch(() => null);
  const econ = new Map((cmp?.mine ?? []).filter((x) => x.economy).map((x) => [x.vehicleId, x.economy]));
  const all = state.vehicles;
  const live = all.filter((v) => !v.archived);
  const archived = all.filter((v) => v.archived);
  let n = 0;
  const card = (v) => {
    const e = econ.get(v.id);
    const isActive = active?.id === v.id;
    return h('li', {}, h('a', { class: 'm-vrow', href: detailHref(v), 'aria-current': isActive ? 'true' : undefined },
      avatar(v, n++),
      h('span', { class: 'm-vrow-text' },
        h('span', { class: 'm-vrow-name' }, h('span', { class: 'm-vrow-title' }, vehicleTitle(v)), isActive ? h('span', { class: 'm-pill' }, 'Active') : null, v.archived ? h('span', { class: 'm-pill m-pill-warn' }, 'Archived') : null),
        h('span', { class: 'm-vrow-sub' }, describe(v))),
      e ? h('span', { class: 'm-econ m-econ-col' }, h('span', { class: 'm-econ-v' }, e.value), h('span', { class: 'm-econ-u' }, unitText(e.unit)), h('span', { class: 'm-vh' }, ' over 90 days')) : null,
      icon('next', 'icon m-row-next')));
  };
  const group = (label, list, id) => list.length ? h('section', { class: 'm-stack-s', 'aria-labelledby': id },
    h('h2', { class: 'm-label m-label-out', id }, label), h('ul', { class: 'm-card m-vlist' }, list.map(card))) : null;

  const openCreate = () => formSheet('Add a vehicle', createForm(false));
  const openImport = () => formSheet('Import a vehicle', importForm(false), 'From a DriveLoom JSON export');
  const head = h('div', { class: 'm-title-row' },
    h('h1', {}, 'Vehicles'),
    h('button', { type: 'button', class: 'm-icon-btn m-icon-accent', 'aria-label': 'Add a vehicle', onclick: openCreate }, icon('plus')));

  if (!all.length) {
    return h('div', { class: 'm-screen m-stack' }, head,
      h('section', { class: 'm-card m-empty', 'aria-labelledby': 'm-nov-h' },
        h('span', { class: 'm-empty-art', 'aria-hidden': 'true' }, icon('car')),
        h('h2', { id: 'm-nov-h' }, 'No vehicles yet'),
        h('p', {}, 'Add your vehicle to start logging fill-ups, or ask an owner to share theirs with you.'),
        h('div', { class: 'm-actions' }, h('button', { type: 'button', onclick: openCreate }, icon('plus'), 'Add a vehicle'), h('button', { type: 'button', class: 'secondary', onclick: openImport }, icon('upload'), 'Import'))));
  }
  const showArchived = query.get('archived') === '1';
  return h('div', { class: 'm-screen m-stack' }, head,
    group('Yours', live.filter((v) => v.role === 'owner'), 'm-g-own'),
    group('Shared with you', live.filter((v) => v.role !== 'owner'), 'm-g-shared'),
    archived.length ? h('details', { class: 'm-card m-fold', open: showArchived },
      h('summary', {}, h('span', { class: 'm-fold-text' }, `Archived (${archived.length})`), icon('chevron', 'icon m-fold-caret')),
      h('ul', { class: 'm-vlist' }, archived.map(card))) : null,
    h('nav', { class: 'm-card m-rows', 'aria-label': 'Add vehicles' }, h('ul', {},
      h('li', {}, h('button', { type: 'button', class: 'm-row m-row-btn', onclick: openCreate }, icon('plus'), h('span', { class: 'm-row-label' }, 'Add a vehicle'), icon('next', 'icon m-row-next'))),
      h('li', {}, h('button', { type: 'button', class: 'm-row m-row-btn', onclick: openImport }, icon('upload'), h('span', { class: 'm-row-label' }, 'Import a vehicle', h('span', { class: 'm-row-sub' }, 'From a DriveLoom JSON export')), icon('next', 'icon m-row-next'))))),
    econ.size ? h('p', { class: 'm-small m-muted m-foot' }, 'Economy is the average over the last 90 days.') : null);
}

// ---------- detail hub ----------
const SECTION_ROWS = [['members', 'users', 'Members', 'Who can see and log fill-ups'], ['data', 'swap', 'Import & export', 'CSV and JSON files'], ['settings', 'gear', 'Vehicle settings', 'Details, photo, sharing with friends, archive']];

export async function detailScreen(id, query, active) {
  const v = await get(`/v1/vehicles/${id}`);
  const win = PERIODS.some(([k]) => k === query.get('window')) ? query.get('window') : '365';
  const days = win === 'all' ? null : Number(win);
  const from = days ? new Date(Date.now() - days * DAY) : null;
  const months = lastMonths();
  const [cur, ...monthly] = await Promise.all([get(statsUrl(v, from, null)), ...months.map((m) => get(statsUrl(v, m.from, m.to)))]);
  const isActive = active?.id === v.id;

  const head = h('div', { class: 'm-stack-s' },
    back('#/garage', 'Vehicles'),
    h('div', { class: 'm-title-row m-title-top' },
      v.imageVersion ? h('img', { class: 'm-vphoto', src: `/v1/vehicles/${v.id}/image?v=${v.imageVersion}`, alt: '' }) : avatar(v, 0),
      h('div', { class: 'm-title-text' }, h('h1', {}, vehicleTitle(v)), h('p', { class: 'm-sub' }, [describe(v), v.archived ? 'Archived' : ''].filter(Boolean).join(' · ')))),
    v.archived ? null : isActive
      ? h('p', { class: 'm-pill m-pill-lg' }, icon('check'), 'Active vehicle for Home, History and Fill up')
      : h('button', { type: 'button', class: 'secondary m-wide', onclick: () => { rememberVehicle(v.id); go(`#/vehicles/${v.id}`); } }, icon('check'), 'Set as active vehicle'));

  // ---- economy ----
  const unit = cur.economy?.unit ?? state.prefs?.economyUnit ?? 'l_per_100km';
  const lower = lowerIsBetter(unit);
  const better = (a, b) => { const c = Dec.parse(a.economy).cmp(Dec.parse(b.economy)); return lower ? c < 0 : c > 0; };
  const best = cur.series.reduce((b, p) => (!b || better(p, b) ? p : b), null);
  const worst = cur.series.reduce((b, p) => (!b || better(b, p) ? p : b), null);
  const economy = h('section', { class: 'm-card m-pad', 'aria-labelledby': 'm-ec-h' },
    h('div', { class: 'm-card-head' }, h('h2', { id: 'm-ec-h' }, 'Economy'), h('span', { class: 'm-small m-muted' }, `${unitText(unit)} · ${lower ? 'lower' : 'higher'} is better`)),
    touchEconomyChart(cur.series, unit, { average: cur.economy?.value ?? null }));
  const fig = (k, val, sub) => h('div', { class: 'm-stat' }, h('dt', {}, k), h('dd', {}, h('span', { class: 'm-stat-v' }, val), sub ? h('span', { class: 'm-stat-sub' }, sub) : null));
  const figures = h('dl', { class: 'm-stats m-stats-3' },
    fig('Average', cur.economy ? cur.economy.value : '—', cur.economy ? unitText(unit) : null),
    fig('Best', best ? best.economy : '—', best ? date(best.at) : null),
    fig('Worst', worst ? worst.economy : '—', worst ? date(worst.at) : null));

  // ---- monthly cost (the desktop dashboard's twelve monthly windows) ----
  const spendItems = months.map((m, i) => ({ label: m.label, long: m.long, value: Number(monthly[i].spend.amount), text: money(monthly[i].spend.amount, monthly[i].spend.currency) }));
  const costed = monthly.filter((st) => st.spend.costedFillCount);
  const yearTotal = costed.length ? costed.reduce((t, st) => t.add(Dec.parse(st.spend.amount)), Dec.ZERO) : null;
  const scale = Math.max(0, ...costed.map((st) => (st.spend.amount.split('.')[1] ?? '').length));
  const cost = h('section', { class: 'm-card m-pad', 'aria-labelledby': 'm-mc-h' },
    h('div', { class: 'm-card-head' }, h('h2', { id: 'm-mc-h' }, 'Monthly cost'), yearTotal ? h('span', { class: 'm-small m-muted' }, `${money(yearTotal.toFixed(scale), v.currency)} in 12 months`) : null),
    barChart({ items: spendItems, label: `spending per month in ${v.currency}`, unitLabel: `Spent (${v.currency})`, tick: compactMoney(v.currency), empty: 'No costs recorded in the last 12 months.' }),
    h('p', { class: 'm-small m-muted' }, `This month so far: ${spendItems.at(-1).text}. Tap a bar to read it.`));

  const showService = await serviceVisible(v.id);
  const rows = showService ? [['service', 'wrench', 'Service', 'Oil changes, repairs and costs'], ...SECTION_ROWS] : SECTION_ROWS;
  const sections = h('nav', { class: 'm-stack-s', 'aria-labelledby': 'm-sec-h' },
    h('h2', { class: 'm-label m-label-out', id: 'm-sec-h' }, 'This vehicle'),
    h('ul', { class: 'm-card m-rows' }, rows.map(([key, ic, label, sub]) => h('li', {},
      h('a', { class: 'm-row', href: `#/vehicles/${v.id}/${key}` }, icon(ic), h('span', { class: 'm-row-label' }, label, h('span', { class: 'm-row-sub' }, sub)), icon('next', 'icon m-row-next'))))));

  return h('div', { class: 'm-screen m-stack' }, head,
    periodControl(win, (k) => `${detailHref(v)}${k === '365' ? '' : `?window=${k}`}`),
    economy, figures, cost, sections,
    h('p', { class: 'm-small m-muted m-foot' }, `${cur.fillCount} fill-ups in the ${PERIODS.find(([k]) => k === win)[1].toLowerCase()}, ${qty(cur.distance)} on ${qty(cur.volume)}.`));
}

// ---------- sections ----------
const sectionHead = (v, title, sub) => h('div', { class: 'm-stack-s' }, back(detailHref(v), vehicleTitle(v)),
  h('div', { class: 'm-title-text' }, h('h1', {}, title), sub ? h('p', { class: 'm-sub' }, sub) : null));

export async function sectionScreen(id, section) {
  const v = await get(`/v1/vehicles/${id}`);
  const titles = { members: 'Members', data: 'Import & export', settings: 'Vehicle settings' };
  const body = section === 'members' ? await membersBody(v) : section === 'data' ? dataBody(v) : await settingsBody(v);
  return { vehicle: v, title: titles[section], view: h('div', { class: 'm-screen m-stack' }, sectionHead(v, titles[section], vehicleTitle(v)), body) };
}

async function membersBody(v) {
  const { items } = await get(`/v1/vehicles/${v.id}/members`);
  const me = state.account.id;
  const owner = v.role === 'owner';
  const who = (m) => m.displayName || m.email;
  const initials = (m) => who(m).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

  const manage = (m) => {
    const self = m.userId === me;
    const parts = [];
    if (owner && !self) {
      parts.push(h('div', { class: 'm-field' }, h('p', { class: 'm-label', id: 'm-role-l' }, 'Role'),
        h('div', { class: 'm-seg', role: 'group', 'aria-labelledby': 'm-role-l' }, GRANTABLE_ROLES.map(([r, label]) =>
          h('button', { type: 'button', class: 'm-seg-opt', 'aria-pressed': String(m.role === r), onclick: async () => {
            if (m.role === r) return;
            try { await put(`/v1/vehicles/${v.id}/members/${m.userId}`, { role: r }); sheet.close(); toast('Role changed.'); render(); } catch (err) { toast(err.message); }
          } }, label))),
        h('p', { class: 'm-small m-muted' }, ROLE_HELP[m.role] ?? '')));
      parts.push(h('div', { class: 'm-actions m-actions-col' },
        h('button', { type: 'button', class: 'secondary', onclick: async () => {
          if (await confirmSheet({ title: 'Transfer ownership?', message: `${who(m)} becomes the owner of ${vehicleTitle(v)}. You become an Authorized Manager and can no longer manage members; the new owner can change your role.`, confirmLabel: 'Make owner', action: () => put(`/v1/vehicles/${v.id}/owner`, { userId: m.userId }) })) {
            sheet.close(); toast('Ownership transferred.'); render();
          }
        } }, icon('key'), 'Make owner'),
        h('button', { type: 'button', class: 'danger', onclick: async () => {
          if (await confirmSheet({ title: 'Remove this member?', message: `${who(m)} loses access to ${vehicleTitle(v)} and its fill-ups.`, confirmLabel: 'Remove member', action: () => del(`/v1/vehicles/${v.id}/members/${m.userId}`) })) {
            sheet.close(); toast('Member removed.'); render();
          }
        } }, glyph('trash'), 'Remove from vehicle')));
    } else if (self && m.role !== 'owner') {
      parts.push(h('p', {}, `You are ${m.role === 'editor' ? 'an' : 'a'} ${ROLE[m.role] ?? m.role} of this vehicle. ${ROLE_HELP[m.role] ?? ''}`),
        h('div', { class: 'm-actions m-actions-col' }, h('button', { type: 'button', class: 'danger', onclick: async () => {
          if (await confirmSheet({ title: 'Leave this vehicle?', message: `You will lose access to ${vehicleTitle(v)} and its fill-ups until an owner adds you again.`, confirmLabel: 'Leave vehicle', action: () => del(`/v1/vehicles/${v.id}/members/${m.userId}`) })) {
            sheet.close(); go('#/garage');
          }
        } }, icon('logout'), 'Leave vehicle')));
    }
    const sheet = openSheet({ title: who(m), sub: `${m.email} · ${ROLE[m.role]}`, content: parts });
  };

  const canManage = (m) => (owner && m.role !== 'owner') || (m.userId === me && m.role !== 'owner');
  const rows = items.map((m) => {
    const inner = [h('span', { class: 'm-avatar m-avatar-sm', 'aria-hidden': 'true' }, initials(m)),
      h('span', { class: 'm-row-label' }, `${who(m)}${m.userId === me ? ' (you)' : ''}`, h('span', { class: 'm-row-sub' }, m.email)),
      h('span', { class: `m-pill${m.role === 'owner' ? '' : ' m-pill-quiet'}` }, ROLE[m.role])];
    return h('li', {}, canManage(m)
      ? h('button', { type: 'button', class: 'm-row m-row-btn', 'aria-label': `${who(m)}, ${ROLE[m.role]}. Manage`, onclick: () => manage(m) }, inner, icon('next', 'icon m-row-next'))
      : h('div', { class: 'm-row' }, inner));
  });

  const addMember = () => formSheet('Share this vehicle', form({ class: 'm-form' }, [
    h('p', { class: 'm-small m-muted' }, 'Add a person who already has an account on this server. Only you, the owner, can manage members.'),
    field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'off' })),
    field('Role', select('role', GRANTABLE_ROLES.map(([r, label]) => [r, `${label}: ${ROLE_HELP[r]}`]), 'viewer')),
    h('button', { type: 'submit', class: 'm-wide' }, icon('plus'), 'Add member'),
  ], async (x) => { await post(`/v1/vehicles/${v.id}/members`, { email: x.email, role: x.role }); render(); return 'Member added.'; }));

  return h('div', { class: 'm-stack' },
    h('ul', { class: 'm-card m-rows', 'aria-label': 'Members' }, rows),
    owner ? h('button', { type: 'button', class: 'm-wide', onclick: addMember }, icon('plus'), 'Add a member') : null,
    h('p', { class: 'm-small m-muted' }, owner ? 'Tap a member to change their role, make them the owner or remove them.' : 'Only the owner manages members.'));
}

function dataBody(v) {
  const canEdit = canEditVehicle(v) && !v.archived;
  const exporter = (format, label, sub) => h('li', {}, h('button', { type: 'button', class: 'm-row m-row-btn', onclick: async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try {
      const res = await api('GET', `/v1/vehicles/${v.id}/export?format=${format}`, undefined, { raw: true });
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `driveloom.${format}`;
      download(name, await res.blob());
    } catch (err) { toast(err.message); } finally { b.disabled = false; }
  } }, icon('download'), h('span', { class: 'm-row-label' }, label, h('span', { class: 'm-row-sub' }, sub))));

  const openImport = () => {
    const report = h('div', { class: 'm-report', 'aria-live': 'polite' });
    const show = (r) => report.replaceChildren(h('div', { class: r.committed ? 'notice' : r.summary.invalid ? 'error' : 'notice' },
      h('p', {}, r.committed ? 'Imported.' : r.dryRun ? 'Preview only. Nothing has been saved yet.' : 'Nothing was imported.'),
      h('p', {}, `${r.summary.total} rows: ${r.summary.created} ${r.committed ? 'added' : 'to add'}, ${r.summary.duplicates} already present, ${r.summary.invalid} invalid.`),
      r.serviceVisits ? h('p', {}, `${r.serviceVisits.total} service visits: ${r.serviceVisits.created} ${r.committed ? 'added' : 'to add'}, ${r.serviceVisits.duplicates} already present, ${r.serviceVisits.invalid} invalid.`) : null,
      r.errors.length ? h('ul', {}, r.errors.slice(0, 20).map((x) => h('li', {}, `Row ${x.row}: ${x.message}`))) : null));
    const f = form({ class: 'm-form' }, [
      h('p', { class: 'm-small m-muted' }, 'A DriveLoom CSV or JSON export, or a CSV with the columns occurred_at, odometer, odometer_unit, volume, volume_unit and optionally full, missed_previous, cost_amount, cost_currency, exchange_rate, reporting_amount, notes. Rows already present are skipped; if any row is invalid, nothing is imported.'),
      field('File', h('input', { name: 'file', type: 'file', accept: '.csv,.json,text/csv,application/json', required: true })),
      h('div', { class: 'm-actions' }, h('button', { type: 'submit', class: 'secondary', name: 'mode', value: 'preview' }, 'Preview'), h('button', { type: 'submit', name: 'mode', value: 'commit' }, 'Import')),
      report,
    ], async (_x, el, submitter) => {
      const file = el.querySelector('input[type=file]').files[0];
      const text = await file.text();
      const json = /\.json$/i.test(file.name) || file.type === 'application/json';
      let data = text;
      if (json) { try { data = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); } }
      try {
        const r = await post(`/v1/vehicles/${v.id}/import`, { format: json ? 'json' : 'csv', data, dryRun: submitter?.value !== 'commit' });
        show(r);
      } catch (err) { if (err.problem?.report) { show(err.problem.report); return; } throw err; }
    });
    formSheet('Import fill-ups', f, vehicleTitle(v));
  };

  return h('div', { class: 'm-stack' },
    h('section', { class: 'm-stack-s', 'aria-labelledby': 'm-ex-h' },
      h('h2', { class: 'm-label m-label-out', id: 'm-ex-h' }, 'Export'),
      h('ul', { class: 'm-card m-rows' }, exporter('csv', 'Download CSV', 'Opens in any spreadsheet'), exporter('json', 'Download JSON', 'Vehicle details too; can create the vehicle on another server')),
      h('p', { class: 'm-small m-muted' }, 'Neither file contains member names or emails.')),
    canEdit ? h('section', { class: 'm-stack-s', 'aria-labelledby': 'm-im-h' },
      h('h2', { class: 'm-label m-label-out', id: 'm-im-h' }, 'Import'),
      h('ul', { class: 'm-card m-rows' }, h('li', {}, h('button', { type: 'button', class: 'm-row m-row-btn', onclick: openImport }, icon('upload'), h('span', { class: 'm-row-label' }, 'Import fill-ups', h('span', { class: 'm-row-sub' }, 'Preview first, then import')), icon('next', 'icon m-row-next'))))) : null);
}

async function settingsBody(v) {
  const owner = v.role === 'owner';
  const canEdit = canEditVehicle(v);
  const optIn = await get(`/v1/vehicles/${v.id}/comparison`);
  const vis = await get(`/v1/vehicles/${v.id}/service-visibility`);
  const rowBtn = (ic, label, sub, onclick) => h('li', {}, h('button', { type: 'button', class: 'm-row m-row-btn', onclick }, ic, h('span', { class: 'm-row-label' }, label, sub ? h('span', { class: 'm-row-sub' }, sub) : null), icon('next', 'icon m-row-next')));

  const openDetails = () => formSheet('Vehicle details', form({ class: 'm-form' }, [
    field('Nickname (optional)', h('input', { name: 'name', maxlength: 80, value: v.name ?? '' })),
    makeModelFields(v),
    field('Year', h('input', { name: 'year', type: 'number', inputmode: 'numeric', value: v.year ?? '' })),
    field('State or province (optional)', h('input', { name: 'plateRegion', maxlength: 10, value: v.plateRegion ?? '', autocomplete: 'off' })),
    field('Licence plate (optional)', h('input', { name: 'plateNumber', maxlength: 12, value: v.plateNumber ?? '', autocomplete: 'off' })),
    field('VIN (optional)', h('input', { name: 'vin', maxlength: 20, value: v.vin ?? '', autocomplete: 'off' }), 'Plate and VIN are visible only to this vehicle’s members, never to friends.'),
    field('Odometer unit', select('odometerUnit', [['km', 'Kilometres'], ['mi', 'Miles']], v.odometerUnit)),
    field('Reporting currency', select('currency', currencyOptions(v.currency), v.currency), 'Cannot change once costs are recorded.'),
    h('button', { type: 'submit', class: 'm-wide' }, icon('check'), 'Save details'),
  ], async (x) => {
    await patch(`/v1/vehicles/${v.id}`, { name: x.name || null, make: x.make || null, model: x.model || null, year: x.year ? Number(x.year) : null, plateRegion: x.plateRegion || null, plateNumber: x.plateNumber || null, vin: x.vin || null, odometerUnit: x.odometerUnit, currency: x.currency });
    render(); return 'Saved.';
  }), vehicleTitle(v));

  const openPhoto = () => formSheet('Photo', form({ class: 'm-form' }, [
    v.imageVersion ? h('img', { class: 'm-photo-preview', src: `/v1/vehicles/${v.id}/image?v=${v.imageVersion}`, alt: `Photo of ${vehicleLabel(v)}` }) : null,
    field('Image', h('input', { name: 'image', type: 'file', accept: 'image/jpeg,image/png,image/webp', required: true }), 'JPEG, PNG or WebP, up to 5 MB. Only members can see it.'),
    h('div', { class: 'm-actions' },
      v.imageVersion ? h('button', { type: 'button', class: 'danger', onclick: async () => {
        if (await confirmSheet({ title: 'Remove the photo?', message: `The photo of ${vehicleTitle(v)} is deleted for every member.`, confirmLabel: 'Remove photo', action: () => del(`/v1/vehicles/${v.id}/image`) })) { toast('Photo removed.'); render(); }
      } }, 'Remove') : null,
      h('button', { type: 'submit' }, icon('upload'), 'Upload')),
  ], async (_x, el) => {
    const file = el.querySelector('input[type=file]').files[0];
    if (file.size > 5 * 1024 * 1024) throw new Error('That image is larger than 5 MB.');
    await put(`/v1/vehicles/${v.id}/image`, file); render(); return 'Photo updated.';
  }), vehicleTitle(v));

  const shareId = 'm-share-sw';
  const share = h('section', { class: 'm-card m-pad m-stack-s', 'aria-labelledby': 'm-share-h' },
    h('h2', { id: 'm-share-h' }, 'Compare with friends'),
    owner ? h('div', { class: 'm-switch-row' },
      h('label', { for: shareId }, 'Share this vehicle’s economy with my friends'),
      h('input', { id: shareId, type: 'checkbox', role: 'switch', class: 'm-toggle', checked: optIn.enabled, onchange: async (e) => {
        const on = e.target.checked;
        try { await put(`/v1/vehicles/${v.id}/comparison`, { enabled: on }); toast(on ? 'Shared with friends.' : 'No longer shared.'); } catch (err) { e.target.checked = !on; toast(err.message); }
      } }))
      : h('p', {}, optIn.enabled ? 'The owner shares this vehicle with their friends.' : 'Not shared. Only the owner can change this.'),
    h('p', { class: 'm-small m-muted' }, 'Friends see the nickname, make, model, year and the average economy for the period they choose. Never the plate or VIN, fill-ups, dates, distances, notes or members.'));

  const svcId = 'm-svc-sw';
  const service = vis.moduleEnabled ? h('section', { class: 'm-card m-pad m-stack-s', 'aria-labelledby': 'm-svc-h' },
    h('h2', { id: 'm-svc-h' }, 'Service page'),
    h('div', { class: 'm-switch-row' },
      h('label', { for: svcId }, 'Show Service page for this vehicle'),
      h('input', { id: svcId, type: 'checkbox', role: 'switch', class: 'm-toggle', checked: vis.showService, onchange: async (e) => {
        const on = e.target.checked;
        try { await put(`/v1/vehicles/${v.id}/service-visibility`, { showService: on }); toast(on ? 'Service page shown.' : 'Service page hidden.'); } catch (err) { e.target.checked = !on; toast(err.message); }
      } })),
    h('p', { class: 'm-small m-muted' }, 'Only changes your own menus. Service data and what you are allowed to do are not affected.')) : null;

  const archive = owner ? h('section', { class: 'm-card m-pad m-stack-s', 'aria-labelledby': 'm-arch-h' },
    h('h2', { id: 'm-arch-h' }, v.archived ? 'Archived' : 'Archive'),
    h('p', { class: 'm-small m-muted' }, v.archived ? 'Archived vehicles are read-only and folded away in Vehicles.' : 'Archive a vehicle you no longer drive. Its history stays and can be exported.'),
    h('button', { type: 'button', class: v.archived ? 'secondary m-wide' : 'danger m-wide', onclick: async () => {
      const to = !v.archived;
      const ok = to
        ? await confirmSheet({ title: 'Archive this vehicle?', message: `${vehicleTitle(v)} becomes read-only for every member and moves to the archived list. You can unarchive it later.`, confirmLabel: 'Archive vehicle', action: () => put(`/v1/vehicles/${v.id}/archive`, { archived: true }) })
        : await put(`/v1/vehicles/${v.id}/archive`, { archived: false }).then(() => true, (err) => { toast(err.message); return false; });
      if (ok) { toast(to ? 'Vehicle archived.' : 'Vehicle unarchived.'); render(); }
    } }, glyph('archive'), v.archived ? 'Unarchive' : 'Archive vehicle'),
    v.archived ? [
      h('p', { class: 'm-small m-muted' }, 'Deleting cannot be undone. The vehicle and all its fill-ups, service history, attachments, maintenance tasks, members and photo are removed for every member.'),
      h('button', { type: 'button', class: 'danger m-wide', onclick: async () => {
        const ok = await confirmSheet({ title: 'Delete this vehicle permanently?', message: `${vehicleTitle(v)} and all of its fill-ups, service history and attachments, maintenance tasks, members and photo are erased for every member. This cannot be undone.`, confirmLabel: 'Delete permanently', action: () => del(`/v1/vehicles/${v.id}`) });
        if (ok) { forgetVehicle(v.id); toast('Vehicle deleted.'); go('#/garage'); }
      } }, glyph('trash'), 'Delete permanently'),
    ] : h('p', { class: 'm-small m-muted' }, 'To delete this vehicle permanently, archive it first.'),
    h('p', { class: 'm-small m-muted' }, 'To hand this vehicle to someone else, add them as a member, then choose “Make owner” on Members.')) : null;

  return h('div', { class: 'm-stack' },
    canEdit ? h('ul', { class: 'm-card m-rows', 'aria-label': 'Edit' },
      rowBtn(glyph('edit'), 'Details', [vehicleDescription(v), v.plateNumber ? [v.plateRegion, v.plateNumber].filter(Boolean).join(' ') : ''].filter(Boolean).join(' · ') || 'Nickname, make, model, plate, units', openDetails),
      rowBtn(glyph('image'), 'Photo', v.imageVersion ? 'Change or remove the photo' : 'Add a photo', openPhoto)) : null,
    share, service, archive);
}
