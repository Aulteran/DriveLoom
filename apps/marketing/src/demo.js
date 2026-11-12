// Interactive tour of the DriveLoom web client, on sample data. Everything
// stays in memory: no storage, no cookies, no network requests. The screens
// and rules mirror apps/web (fuel log, statistics, members, friends, import
// and export) and the economy maths follows the platform's full-to-full method.
(() => {
  'use strict';
  const root = document.querySelector('[data-tour]');
  if (!root) return;

  // ---------- units ----------
  const KM_PER_MI = 1.609344;
  const L_PER = { l: 1, gal_us: 3.785411784, gal_imp: 4.54609 };
  const UNIT = { km: 'km', mi: 'mi', l: 'L', gal_us: 'US gal', gal_imp: 'imp gal', l_per_100km: 'L/100 km', km_per_l: 'km/L', mpg_us: 'mpg (US)', mpg_imp: 'mpg (imp)' };
  const toDist = (km, u) => (u === 'mi' ? km / KM_PER_MI : km);
  const toVol = (l, u) => l / L_PER[u];
  const toEcon = (lp100, u) => {
    if (u === 'l_per_100km') return lp100;
    const kmPerL = 100 / lp100;
    if (u === 'km_per_l') return kmPerL;
    return (kmPerL / KM_PER_MI) * L_PER[u === 'mpg_us' ? 'gal_us' : 'gal_imp'];
  };
  const num = (n, d) => n.toLocaleString('en', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false });
  const qty = (n, u, d) => `${num(n, d)} ${UNIT[u]}`;
  const money = (n, c, d = 2) => new Intl.NumberFormat('en', { style: 'currency', currency: c, minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
  const DAY = 86_400_000;
  const today = new Date(); today.setHours(9, 30, 0, 0);
  const daysAgo = (n) => new Date(today.getTime() - n * DAY);
  const date = (d) => d.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
  const ROLE = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
  const REASONS = { partial_fill: 'Partial fill', no_previous_full_fill: 'First full fill', missed_fill: 'Missed purchase' };

  // ---------- sample data ----------
  // [days ago, odometer (vehicle unit), volume, volume unit, full, missed earlier purchase, amount, currency, reporting amount, note]
  const SAMPLE = {
    hatch: {
      name: 'Blue Hatch', desc: '2019 Compact hatchback', role: 'owner', odoUnit: 'km', currency: 'EUR', shared: true,
      fills: [
        [362, 41210, 38.4, 'l', true, false, 66.82], [340, 41790, 39.1, 'l', true, false, 67.25], [318, 42355, 37.2, 'l', true, false, 63.61],
        [300, 42620, 15, 'l', false, false, 26.1, 'EUR', null, 'Top-up on the motorway'], [291, 42905, 20.9, 'l', true, false, 36.16],
        [266, 43480, 40.3, 'l', true, false, 70.53, 'EUR', null, 'Winter tyres on'], [240, 44050, 10.04, 'gal_us', true, false, 44.98, 'USD', 41.38, 'Road trip, paid in dollars'],
        [214, 44640, 36.5, 'l', true, false, 62.78], [190, 45950, 37, 'l', true, true, 64.38, 'EUR', null, 'Lost a receipt before this one'],
        [168, 46530, 37.6, 'l', true, false, 65.8], [140, 47120, 38.9, 'l', true, false, 69.24], [112, 47700, 36.2, 'l', true, false, 63.71],
        [86, 48010, 18, 'l', false, false, 31.86, 'EUR', null, 'Half tank before the ferry'], [77, 48290, 18.9, 'l', true, false, 33.08],
        [52, 48870, 37.8, 'l', true, false, 66.53], [27, 49445, 38.6, 'l', true, false, 67.94], [3, 50020, 39.2, 'l', true, false, 68.21],
      ],
      members: [
        { name: 'Robin Ash', email: 'robin@example.com', role: 'owner', me: true },
        { name: 'Alex Rivera', email: 'alex@example.com', role: 'editor' },
        { name: 'Mia Chen', email: 'mia@example.com', role: 'viewer' },
      ],
    },
    van: {
      name: 'Family Van', desc: '2017 Seven-seat minivan', role: 'editor', odoUnit: 'mi', currency: 'USD', shared: false,
      fills: [
        [150, 23110, 14.2, 'gal_us', true, false, 48.14], [120, 23480, 15.1, 'gal_us', true, false, 52.7], [95, 23850, 14.8, 'gal_us', true, false, 50.17],
        [70, 24120, 9, 'gal_us', false, false, 31.05], [61, 24240, 6.1, 'gal_us', true, false, 20.92, 'USD', null, 'School run week'],
        [33, 24610, 15, 'gal_us', true, false, 51.3], [9, 24975, 14.6, 'gal_us', true, false, 49.79],
      ],
      members: [
        { name: 'Alex Rivera', email: 'alex@example.com', role: 'owner' },
        { name: 'Robin Ash', email: 'robin@example.com', role: 'editor', me: true },
        { name: 'Sam Okafor', email: 'sam@example.com', role: 'viewer' },
      ],
    },
  };
  const INSTANCE_USERS = { 'sam@example.com': 'Sam Okafor', 'priya@example.com': 'Priya Shah', 'jonas@example.com': 'Jonas Berg', 'lee@example.com': 'Lee Park' };
  // Friends' shared aggregates, in L/100 km and EUR per km (Priya reports in GBP).
  const FRIENDS = [
    { who: 'Sam', label: 'Roadster · 2016 Two-seater', econ: { 90: 8.1, 365: 7.9, all: 8.0 }, cost: { 90: 0.142, 365: 0.139, all: 0.14 }, currency: 'EUR', since: 210 },
    { who: 'Priya', label: 'Estate · 2022 Hybrid estate', econ: { 90: 4.6, 365: 4.8, all: 4.7 }, currency: 'GBP', since: 120 },
    { who: 'Jonas', label: 'Work van', econ: null, currency: null, since: 40 },
  ];
  const LEE = { who: 'Lee', label: 'Commuter · 2020 Compact', econ: { 90: 5.9, 365: 6.1, all: 6.0 }, cost: { 90: 0.105, 365: 0.108, all: 0.107 }, currency: 'EUR', since: 0 };
  const WINDOWS = [['90', 'Last 90 days'], ['365', 'Last year'], ['all', 'All time']];

  function load(key) {
    const v = SAMPLE[key];
    return {
      ...v, key,
      members: v.members.map((m) => ({ ...m })),
      fills: v.fills.map(([d, odo, vol, volUnit, full, missed, amount, currency = v.currency, reporting = null, note = '']) => ({
        at: daysAgo(d), odo, vol, volUnit, full, missed, note, cost: { amount, currency, reporting: currency === v.currency ? amount : reporting },
      })),
    };
  }
  const fresh = () => ({
    tab: 'stats', vehicle: 'hatch', logAll: false, win: '365', friendsWin: '90', added: null,
    prefs: { dist: 'km', vol: 'l', econ: 'l_per_100km' },
    vehicles: { hatch: load('hatch'), van: load('van') },
    friends: FRIENDS.map((f) => ({ ...f })), incoming: [{ ...LEE, name: 'Lee Park', email: 'lee@example.com' }],
  });
  let state = fresh();

  // ---------- economy: full-to-full ----------
  // A full fill closes an interval that starts at the previous full fill. Fuel
  // from partial fills in between counts toward it; the starting fill does not.
  // An interval with a missed purchase is unavailable rather than guessed.
  function analyse(v) {
    const km = (odo) => (v.odoUnit === 'mi' ? odo * KM_PER_MI : odo);
    const fills = [...v.fills].sort((a, b) => a.at - b.at || a.odo - b.odo);
    let start = null, litres = 0, missed = false;
    for (const f of fills) {
      f.litres = f.vol * L_PER[f.volUnit];
      f.km = km(f.odo);
      if (start) { litres += f.litres; missed ||= f.missed; }
      if (!f.full) { f.interval = { reason: 'partial_fill' }; continue; }
      if (!start) f.interval = { reason: 'no_previous_full_fill' };
      else if (missed) f.interval = { reason: 'missed_fill', km: f.km - start.km };
      else f.interval = { available: true, km: f.km - start.km, litres, lp100: (litres / (f.km - start.km)) * 100 };
      start = f; litres = 0; missed = false;
    }
    return fills;
  }

  function stats(v, win) {
    const fills = analyse(v);
    const from = win === 'all' ? -Infinity : today.getTime() - Number(win) * DAY;
    const inWin = fills.filter((f) => f.at.getTime() >= from);
    const closing = inWin.filter((f) => f.interval.available);
    const km = closing.reduce((a, f) => a + f.interval.km, 0);
    const litres = closing.reduce((a, f) => a + f.interval.litres, 0);
    const distance = inWin.length > 1 ? inWin.at(-1).km - inWin[0].km : 0;
    const spent = inWin.reduce((a, f) => a + (f.cost.reporting ?? 0), 0);
    return {
      lp100: km ? (litres / km) * 100 : null, intervals: closing.length, skipped: inWin.filter((f) => f.interval.reason === 'missed_fill').length,
      distance, fuel: inWin.reduce((a, f) => a + f.litres, 0), spent, fillCount: inWin.length,
      series: closing.map((f) => ({ at: f.at, lp100: f.interval.lp100 })),
    };
  }

  // ---------- DOM helpers ----------
  const SVG = 'http://www.w3.org/2000/svg';
  function build(el, attrs, kids) {
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'selected' || k === 'value') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
    return el;
  }
  const h = (tag, attrs, ...kids) => build(document.createElement(tag), attrs, kids);
  const s = (tag, attrs, ...kids) => build(document.createElementNS(SVG, tag), attrs, kids);
  const icon = (name) => s('svg', { class: 'icon', 'aria-hidden': 'true', focusable: 'false' }, s('use', { href: `#i-${name}` }));
  const select = (key, options, value, attrs = {}) => h('select', { 'data-key': key, ...attrs }, options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  const field = (label, control, hint) => {
    const id = `f-${control.getAttribute('data-key') ?? Math.random().toString(36).slice(2)}`;
    control.id = id;
    return h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
  };

  // ---------- chrome ----------
  const TABS = [['garage', 'Vehicles', 'car'], ['log', 'Fuel log', 'fuel'], ['stats', 'Statistics', 'chart'], ['members', 'Members', 'users'], ['friends', 'Friends', 'pulse'], ['data', 'Import & export', 'swap']];
  const PREFS = {
    dist: [['km', 'Kilometres'], ['mi', 'Miles']],
    vol: [['l', 'Litres'], ['gal_us', 'US gallons'], ['gal_imp', 'Imperial gallons']],
    econ: [['l_per_100km', 'L/100 km'], ['km_per_l', 'km/L'], ['mpg_us', 'mpg (US)'], ['mpg_imp', 'mpg (imp)']],
  };
  const pref = (key, label, options, value, onchange) => h('div', { class: 'pref' }, h('label', { for: `pref-${key}` }, label), select(`pref-${key}`, options, value, { id: `pref-${key}`, onchange }));
  const prefs = h('div', { class: 'prefs' });
  const toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  let toastTimer;
  const toast = (msg) => {
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
  };
  const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Demo screens' });
  const panels = {};
  const tabs = {};
  for (const [key, label, ic] of TABS) {
    tabs[key] = h('button', { type: 'button', role: 'tab', id: `tab-${key}`, 'aria-controls': `panel-${key}`, onclick: () => activate(key) }, icon(ic), label);
    panels[key] = h('div', { role: 'tabpanel', id: `panel-${key}`, 'aria-labelledby': `tab-${key}`, tabindex: '0' });
    tablist.append(tabs[key]);
  }
  tablist.addEventListener('keydown', (e) => {
    const keys = TABS.map(([k]) => k);
    const i = keys.indexOf(state.tab);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: keys.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    activate(keys[(next + keys.length) % keys.length]);
    tabs[state.tab].focus();
  });

  const brand = document.querySelector('.brand img')?.getAttribute('src');
  const app = h('div', { class: 'app' },
    h('div', { class: 'app-top', 'aria-hidden': 'true' },
      h('span', { class: 'brand' }, brand ? h('img', { src: brand, alt: '', width: 28, height: 28 }) : null, h('span', {}, 'DriveLoom')),
      h('span', { class: 'fake-nav' }, h('span', { class: 'on' }, icon('car'), 'Vehicles'), h('span', {}, icon('users'), 'Friends'), h('span', {}, icon('sliders'), 'Settings'))),
    h('div', { class: 'app-body' }, tablist, Object.values(panels)),
    toastEl);
  root.append(
    prefs,
    h('div', { class: 'window' },
      h('div', { class: 'window-bar', 'aria-hidden': 'true' }, h('span', { class: 'lights' }, h('span'), h('span'), h('span')), h('span', { class: 'url' }, 'https://fuel.example.com')),
      app),
    h('div', { class: 'tour-foot small muted' },
      h('span', {}, 'Sample data only. Names, vehicles and figures are made up.'),
      h('button', { type: 'button', onclick: () => { state = fresh(); render(); toast('Demo reset.'); } }, 'Reset the demo')));

  function activate(key) {
    state.tab = key;
    render();
  }

  function renderPrefs() {
    const set = (k) => (e) => { state.prefs[k] = e.target.value; render(); };
    prefs.replaceChildren(
      pref('vehicle', 'Vehicle', Object.values(state.vehicles).map((v) => [v.key, v.name]), state.vehicle, (e) => { state.vehicle = e.target.value; state.added = null; render(); }),
      pref('dist', 'Distance', PREFS.dist, state.prefs.dist, set('dist')),
      pref('vol', 'Fuel', PREFS.vol, state.prefs.vol, set('vol')),
      pref('econ', 'Economy', PREFS.econ, state.prefs.econ, set('econ')),
      h('p', { class: 'prefs-note small muted' }, icon('sliders'), 'In the app these are your display preferences under Settings.'));
  }

  function render() {
    const focusKey = document.activeElement?.closest?.('[data-tour]') ? document.activeElement.getAttribute('data-key') : null;
    renderPrefs();
    for (const [key] of TABS) {
      const on = key === state.tab;
      tabs[key].setAttribute('aria-selected', String(on));
      tabs[key].tabIndex = on ? 0 : -1;
      panels[key].hidden = !on;
      panels[key].replaceChildren(...(on ? [VIEWS[key]()] : []));
    }
    if (focusKey) root.querySelector(`[data-key="${focusKey}"]`)?.focus();
  }

  const vehicle = () => state.vehicles[state.vehicle];
  function vehicleHead(v) {
    return h('div', { class: 'app-head' },
      h('div', {}, h('h3', {}, v.name), h('p', { class: 'sub' }, v.desc, ' ', h('span', { class: `badge ${v.role === 'owner' ? 'accent' : ''}` }, ROLE[v.role]))));
  }
  const tableWrap = (label, table) => h('div', { class: 'table-wrap', role: 'region', 'aria-label': label, tabindex: '0' }, table);

  // ---------- views ----------
  const VIEWS = {
    garage() {
      const card = (v) => {
        const st = stats(v, 'all');
        return h('button', { type: 'button', class: 'card', 'data-key': `card-${v.key}`, onclick: () => { state.vehicle = v.key; state.added = null; activate('log'); } },
          h('span', { class: 'photo' }, icon('car')),
          h('span', { class: 'body' },
            h('span', { class: 'row spread' }, h('strong', {}, v.name), h('span', { class: `badge ${v.role === 'owner' ? 'accent' : ''}` }, ROLE[v.role])),
            h('span', { class: 'muted small' }, v.desc),
            h('span', { class: 'meta' },
              h('span', {}, h('b', {}, st.lp100 ? num(toEcon(st.lp100, state.prefs.econ), 1) : '—'), ` ${UNIT[state.prefs.econ]}`),
              h('span', {}, `${v.fills.length} fill-ups`))));
      };
      return h('div', {},
        h('div', { class: 'app-head' }, h('div', {}, h('h3', {}, 'Your vehicles'), h('p', { class: 'sub' }, 'Vehicles you own and vehicles shared with you. Open one to see its log.'))),
        h('div', { class: 'grid' }, Object.values(state.vehicles).map(card)));
    },

    log() {
      const v = vehicle();
      const { dist, vol, econ } = state.prefs;
      const fills = analyse(v).slice().reverse();
      const canEdit = v.role !== 'viewer';
      const row = (f) => h('tr', { class: f === state.added ? 'fresh' : null },
        h('td', {}, date(f.at), f.note ? h('div', { class: 'small muted' }, f.note) : null),
        h('td', { class: 'num' }, qty(toDist(f.km, dist), dist, 0), v.odoUnit !== dist ? h('div', { class: 'small muted' }, `entered ${qty(f.odo, v.odoUnit, 0)}`) : null),
        h('td', { class: 'num' }, qty(toVol(f.litres, vol), vol, 2),
          f.volUnit !== vol ? h('div', { class: 'small muted' }, `entered ${qty(f.vol, f.volUnit, 2)}`) : null,
          f.full ? null : h('div', { class: 'small muted' }, 'partial')),
        h('td', { class: 'num hide-sm' }, money(f.cost.amount, f.cost.currency), f.cost.currency !== v.currency ? h('div', { class: 'small muted' }, `= ${money(f.cost.reporting, v.currency)}`) : null),
        h('td', { class: 'num' }, f.interval.available ? h('strong', {}, qty(toEcon(f.interval.lp100, econ), econ, 2)) : h('span', { class: 'small muted' }, REASONS[f.interval.reason])));
      const slot = h('div');
      const openForm = () => { slot.replaceChildren(fillForm(v, () => slot.replaceChildren())); slot.querySelector('input')?.focus(); };
      return h('div', {},
        vehicleHead(v),
        canEdit ? h('div', { class: 'row', style: null }, h('button', { type: 'button', 'data-key': 'add-fill', onclick: openForm }, icon('plus'), 'Add fill-up')) : null,
        h('div', { class: 'spacer' }),
        slot,
        h('div', { class: 'panel' }, tableWrap('Fuel log', h('table', {},
          h('caption', { class: 'muted small' }, `${state.logAll || fills.length <= 8 ? fills.length : `8 of ${fills.length}`} fill-ups, newest first. Economy is shown on the full fill that closes each interval.`),
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col', class: 'num' }, 'Odometer'), h('th', { scope: 'col', class: 'num' }, 'Fuel'), h('th', { scope: 'col', class: 'num hide-sm' }, 'Cost'), h('th', { scope: 'col', class: 'num' }, 'Economy'))),
          h('tbody', {}, (state.logAll ? fills : fills.slice(0, 8)).map(row)))),
          fills.length > 8 ? h('div', { class: 'row', style: null }, h('button', { type: 'button', class: 'ghost', 'data-key': 'log-all', 'aria-expanded': String(state.logAll), onclick: () => { state.logAll = !state.logAll; render(); } }, state.logAll ? 'Show fewer' : `Show all ${fills.length} fill-ups`)) : null));
    },

    stats() {
      const v = vehicle();
      const { dist, vol, econ } = state.prefs;
      const st = stats(v, state.win);
      const stat = (k, val, note) => h('div', { class: 'stat' }, h('div', { class: 'v' }, val), h('div', { class: 'k' }, k), note ? h('div', { class: 'small muted' }, note) : null);
      const perDist = st.distance ? st.spent / toDist(st.distance, dist) : null;
      return h('div', {},
        vehicleHead(v),
        h('div', { class: 'row', style: null }, h('label', { for: 'f-win' }, 'Period'), select('win', WINDOWS, state.win, { id: 'f-win', onchange: (e) => { state.win = e.target.value; render(); } })),
        h('div', { class: 'spacer' }),
        h('div', { class: 'panel' },
          h('div', { class: 'stats' },
            stat('Average economy', st.lp100 ? qty(toEcon(st.lp100, econ), econ, 2) : '—', st.lp100 ? `over ${st.intervals} full-to-full intervals` : 'needs two full fills in the period'),
            stat('Distance', qty(toDist(st.distance, dist), dist, 0)),
            stat('Fuel', qty(toVol(st.fuel, vol), vol, 1)),
            stat('Spent', money(st.spent, v.currency), `${st.fillCount} fill-ups`),
            stat('Cost per distance', perDist ? `${money(perDist, v.currency, 3)} / ${UNIT[dist]}` : '—')),
          st.skipped ? h('p', { class: 'small muted', style: null }, `${st.skipped} interval in this period is left out because a purchase was missed.`) : null),
        h('div', { class: 'panel' }, h('h4', {}, `Economy (${UNIT[econ]})`), chart(st.series, econ)),
        h('p', { class: 'small muted' }, 'Averages add up distance and fuel first, then divide, so a short interval cannot swing the result.'));
    },

    members() {
      const v = vehicle();
      const owner = v.role === 'owner';
      const rows = v.members.map((m) => h('tr', {},
        h('td', {}, m.name, m.me ? ' (you)' : '', h('div', { class: 'small muted' }, m.email)),
        h('td', {}, owner && m.role !== 'owner'
          ? select(`role-${m.email}`, [['editor', 'Editor'], ['viewer', 'Viewer']], m.role, { 'aria-label': `Role for ${m.name}`, onchange: (e) => { m.role = e.target.value; toast('Role changed.'); } })
          : ROLE[m.role]),
        h('td', { class: 'num' }, owner && m.role !== 'owner'
          ? h('button', { type: 'button', class: 'ghost', 'aria-label': `Remove ${m.name}`, onclick: () => { v.members = v.members.filter((x) => x !== m); render(); toast(`${m.name} removed.`); } }, 'Remove')
          : null)));
      const err = h('div');
      const email = h('input', { type: 'email', 'data-key': 'share-email', required: true, autocomplete: 'off', placeholder: 'sam@example.com' });
      const role = select('share-role', [['viewer', 'Viewer'], ['editor', 'Editor']], 'viewer');
      const share = h('form', { class: 'panel', novalidate: true, onsubmit: (e) => {
        e.preventDefault();
        const addr = email.value.trim().toLowerCase();
        const fail = (msg) => { err.replaceChildren(h('p', { class: 'error', role: 'alert' }, msg)); email.focus(); };
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return fail('Enter an email address.');
        if (v.members.some((m) => m.email === addr)) return fail('That person is already a member.');
        if (!INSTANCE_USERS[addr]) return fail('No user with that email on this instance. Try sam@example.com.');
        v.members.push({ name: INSTANCE_USERS[addr], email: addr, role: role.value });
        render(); toast('Member added.');
      } },
        h('h4', {}, 'Share this vehicle'),
        h('p', { class: 'muted small' }, 'Editors can add and correct fill-ups and edit details. Viewers can only read. Only the owner manages members.'),
        err,
        h('div', { class: 'grid' }, field('Email of a user on this instance', email), field('Role', role)),
        h('button', { type: 'submit' }, 'Add member'));
      const compare = h('div', { class: 'panel' },
        h('h4', {}, 'Compare with friends'),
        h('p', { class: 'muted small' }, 'When on, friends see this vehicle\'s name and description and its average economy for the period they choose. Never fill-ups, dates, distances, notes or members.'),
        owner
          ? h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-key': 'opt-in', checked: v.shared, onchange: (e) => { v.shared = e.target.checked; toast(v.shared ? 'Shared with friends.' : 'No longer shared.'); } }), 'Share this vehicle\'s economy with my friends')
          : h('p', { class: 'small' }, v.shared ? 'The owner shares this vehicle with their friends.' : 'Not shared. Only the owner can change this.'));
      return h('div', {},
        vehicleHead(v),
        h('div', { class: 'panel' }, tableWrap('Members', h('table', {},
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Member'), h('th', { scope: 'col' }, 'Role'), h('th', { scope: 'col', class: 'num' }, h('span', { class: 'hide-sm' }, 'Actions')))),
          h('tbody', {}, rows)))),
        owner ? share : h('p', { class: 'notice small' }, 'You are an editor of this vehicle, so you can log fill-ups but not manage members. Switch to Blue Hatch to try sharing.'),
        compare);
    },

    friends() {
      const econ = state.prefs.econ;
      const w = state.friendsWin;
      const mine = Object.values(state.vehicles).filter((v) => v.role === 'owner' && v.shared)
        .map((v) => { const st = stats(v, w); return { who: 'You', label: `${v.name} · ${v.desc}`, lp100: st.lp100, cost: st.distance ? st.spent / st.distance : null, currency: v.currency }; });
      const rows = [...mine, ...state.friends.map((f) => ({ who: f.who, label: f.label, lp100: f.econ?.[w] ?? null, cost: f.cost?.[w] ?? null, currency: f.currency }))];
      const values = rows.map((r) => (r.lp100 ? toEcon(r.lp100, econ) : 0));
      const max = Math.max(...values, 0) || 1;
      const perDist = state.prefs.dist;
      const costCell = (r) => {
        if (!r.lp100) return h('span', { class: 'small muted' }, 'no cost data');
        if (r.currency !== 'EUR') return h('span', { class: 'small muted' }, 'different currency');
        return money(perDist === 'mi' ? r.cost * KM_PER_MI : r.cost, 'EUR', 3);
      };
      const person = (name, email, extra) => h('li', { class: 'row spread' }, h('div', {}, h('strong', {}, name), h('div', { class: 'small muted' }, email)), h('div', { class: 'row' }, extra));
      return h('div', {},
        h('div', { class: 'app-head' }, h('div', {}, h('h3', {}, 'Friends'), h('p', { class: 'sub' }, 'Averages only, for vehicles their owners chose to share.'))),
        h('div', { class: 'panel' },
          h('div', { class: 'row spread' }, h('h4', {}, 'Comparison'), select('friends-win', [['90', 'Last 90 days'], ['365', 'Last 12 months'], ['all', 'All time']], w, { 'aria-label': 'Comparison period', onchange: (e) => { state.friendsWin = e.target.value; render(); } })),
          tableWrap('Comparison', h('table', {},
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Driver'), h('th', { scope: 'col' }, 'Vehicle'), h('th', { scope: 'col', class: 'num' }, `Economy (${UNIT[econ]})`), h('th', { scope: 'col', class: 'num hide-sm' }, `Cost per ${UNIT[perDist]}`))),
            h('tbody', {}, rows.map((r, i) => h('tr', {},
              h('td', {}, r.who), h('td', {}, r.label),
              h('td', { class: 'num' }, r.lp100
                ? h('div', { class: 'bar-cell' }, h('span', { class: 'bar', style: `width:${Math.max(2, Math.round((values[i] / max) * 120))}px` }), h('strong', {}, num(values[i], 1)))
                : h('span', { class: 'small muted' }, 'not enough full fills')),
              h('td', { class: 'num hide-sm' }, costCell(r))))),
            h('caption', { class: 'small muted' }, econ === 'l_per_100km' ? 'Lower consumption is better.' : 'Higher economy is better.', ' Costs are compared only in your preferred currency, never converted.'))),
          mine.length ? null : h('p', { class: 'small muted' }, 'Your Blue Hatch is hidden because you turned sharing off on its Members tab.')),
        state.incoming.length ? h('div', { class: 'panel' }, h('h4', {}, 'Requests for you'), h('ul', { class: 'list' }, state.incoming.map((r) => person(r.name, r.email, [
          h('button', { type: 'button', 'data-key': 'accept', onclick: () => { state.incoming = []; state.friends.push(LEE); render(); toast('You are now friends with Lee.'); } }, 'Accept'),
          h('button', { type: 'button', class: 'secondary', onclick: () => { state.incoming = []; render(); toast('Request declined.'); } }, 'Decline')])))) : null,
        h('div', { class: 'panel' }, h('h4', {}, 'Your friends'), h('ul', { class: 'list' }, state.friends.map((f) => person(f.who, `${f.who.toLowerCase()}@example.com`, h('span', { class: 'small muted' }, f.since ? `since ${date(daysAgo(f.since))}` : 'just now'))))));
    },

    data() {
      const v = vehicle();
      const report = h('div', { 'aria-live': 'polite' });
      const rows = analyse(v);
      const csv = () => ['occurred_at,odometer,odometer_unit,volume,volume_unit,full,missed_previous,cost_amount,cost_currency,reporting_amount,notes',
        ...rows.map((f) => [f.at.toISOString(), f.odo, v.odoUnit, f.vol, f.volUnit, f.full, f.missed, f.cost.amount.toFixed(2), f.cost.currency, f.cost.currency !== v.currency ? f.cost.reporting.toFixed(2) : '', f.note ? `"${f.note}"` : ''].join(','))].join('\n') + '\n';
      const json = () => JSON.stringify({ format: 'driveloom-vehicle', sample: true, vehicle: { name: v.name, description: v.desc, odometerUnit: v.odoUnit, currency: v.currency }, fillUps: rows.map((f) => ({ occurredAt: f.at.toISOString(), odometer: { value: String(f.odo), unit: v.odoUnit }, volume: { value: String(f.vol), unit: f.volUnit }, full: f.full, missedPrevious: f.missed, cost: { amount: f.cost.amount.toFixed(2), currency: f.cost.currency }, notes: f.note })) }, null, 2);
      const save = (name, type, text) => {
        const url = URL.createObjectURL(new Blob([text], { type }));
        const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast(`Saved ${name} from the sample data.`);
      };
      const slug = v.name.toLowerCase().replace(/\s+/g, '-');
      const sampleCsv = `occurred_at,odometer,odometer_unit,volume,volume_unit,full\n2026-03-02T08:10:00Z,${v.odoUnit === 'km' ? 30110 : 18710},${v.odoUnit},41.2,l,true\n2026-03-19T17:45:00Z,${v.odoUnit === 'km' ? 30690 : 19070},${v.odoUnit},39.8,l,true\n2026-04-04T12:05:00Z,${v.odoUnit === 'km' ? 30590 : 19010},${v.odoUnit},40.1,l,true\n2026-04-21T09:30:00Z,${v.odoUnit === 'km' ? 31260 : 19420},${v.odoUnit},42.0,l,true`;
      return h('div', {},
        vehicleHead(v),
        h('div', { class: 'panel' }, h('h4', {}, 'Export'),
          h('p', { class: 'muted small' }, 'CSV opens in any spreadsheet. JSON includes the vehicle details and can create a new vehicle on another DriveLoom instance. Neither contains member names or emails.'),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'secondary', onclick: () => save(`${slug}-sample.csv`, 'text/csv', csv()) }, icon('download'), 'Download CSV'),
            h('button', { type: 'button', class: 'secondary', onclick: () => save(`${slug}-sample.json`, 'application/json', json()) }, icon('download'), 'Download JSON'))),
        h('div', { class: 'panel' }, h('h4', {}, 'Import fill-ups'),
          h('p', { class: 'muted small' }, 'Use a DriveLoom export or a CSV with your own columns. Rows already present are skipped. If any row is invalid, nothing is imported.'),
          h('pre', { class: 'csv', tabindex: '0', 'aria-label': 'Example CSV from a spreadsheet' }, h('code', {}, sampleCsv)),
          h('div', { class: 'row' },
            h('button', { type: 'button', 'data-key': 'preview-bad', onclick: () => report.replaceChildren(h('div', { class: 'error' },
              h('p', {}, 'Nothing was imported.'), h('p', {}, '4 rows: 3 to add, 0 already present, 1 invalid.'),
              h('ul', {}, h('li', {}, 'Row 3: the odometer is lower than the reading before it.')))) }, icon('upload'), 'Preview this CSV'),
            h('button', { type: 'button', class: 'secondary', 'data-key': 'preview-own', onclick: () => report.replaceChildren(h('div', { class: 'notice' },
              h('p', {}, 'Preview only. Nothing has been saved yet.'), h('p', {}, `${rows.length} rows: 0 to add, ${rows.length} already present, 0 invalid.`))) }, 'Preview my own export')),
          h('div', { class: 'spacer' }), report));
    },
  };

  // ---------- add a fill-up ----------
  function fillForm(v, close) {
    const last = analyse(v).at(-1);
    const err = h('div');
    const odo = h('input', { 'data-key': 'odo', inputmode: 'decimal', required: true, placeholder: String(last.odo + (v.odoUnit === 'km' ? 575 : 360)) });
    const volume = h('input', { 'data-key': 'vol', inputmode: 'decimal', required: true, placeholder: state.prefs.vol === 'l' ? '38.50' : '10.20' });
    const volUnit = select('vol-unit', PREFS.vol.map(([k]) => [k, UNIT[k]]), state.prefs.vol, { 'aria-label': 'Fuel unit' });
    const amount = h('input', { 'data-key': 'amount', inputmode: 'decimal', placeholder: v.currency === 'EUR' ? '67.00' : '50.00' });
    const full = h('input', { type: 'checkbox', checked: true });
    return h('form', { class: 'panel', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const fail = (msg, el) => { err.replaceChildren(h('p', { class: 'error', role: 'alert' }, msg)); el.focus(); };
      const o = Number(odo.value.trim()), q = Number(volume.value.trim()), c = amount.value.trim() ? Number(amount.value.trim()) : 0;
      if (!/^\d+(\.\d{1,3})?$/.test(odo.value.trim())) return fail('Enter the odometer reading as a number.', odo);
      if (o <= last.odo) return fail(`The odometer must be higher than the previous reading (${qty(last.odo, v.odoUnit, 0)}).`, odo);
      if (o - last.odo > (v.odoUnit === 'km' ? 2500 : 1500)) return fail(`That is ${num(o - last.odo, 0)} ${UNIT[v.odoUnit]} since the last fill-up. Check the reading, or tick that you missed a purchase in the app.`, odo);
      if (!/^\d+(\.\d{1,3})?$/.test(volume.value.trim()) || q <= 0) return fail('Enter how much fuel you bought.', volume);
      if (q * L_PER[volUnit.value] > 150) return fail('That is more fuel than a car tank holds. Check the amount and unit.', volume);
      if (amount.value.trim() && !(c >= 0)) return fail('Enter the cost as a number, or leave it empty.', amount);
      const f = { at: new Date(), odo: o, vol: q, volUnit: volUnit.value, full: full.checked, missed: false, note: 'Added in the demo', cost: { amount: c, currency: v.currency, reporting: c } };
      v.fills.push(f);
      state.added = f;
      analyse(v);
      render();
      toast(f.interval.available ? `Fill-up added. This interval: ${qty(toEcon(f.interval.lp100, state.prefs.econ), state.prefs.econ, 2)}.` : 'Fill-up added. Economy appears on the next full fill.');
      root.querySelector('[data-key="add-fill"]')?.focus();
    } },
      h('h4', {}, 'Add a fill-up'),
      err,
      h('div', { class: 'grid' },
        field(`Odometer (${UNIT[v.odoUnit]})`, odo, `Last reading ${qty(last.odo, v.odoUnit, 0)}`),
        h('div', { class: 'field' }, h('label', { for: 'f-vol' }, 'Fuel'), h('div', { class: 'inline' }, Object.assign(volume, { id: 'f-vol' }), volUnit), h('div', { class: 'hint' }, 'In the unit on the pump')),
        field(`Cost in ${v.currency} (optional)`, amount)),
      h('label', { class: 'check' }, full, 'Filled the tank completely'),
      h('div', { class: 'row' }, h('button', { type: 'submit' }, 'Add fill-up'), h('button', { type: 'button', class: 'secondary', onclick: close }, 'Cancel')));
  }

  // ---------- chart (same construction as apps/web/js/views/chart.js) ----------
  function chart(series, unit) {
    if (series.length < 2) return h('p', { class: 'muted' }, 'The chart appears once two complete full-to-full intervals exist.');
    const W = 640, H = 220, P = { l: 48, r: 12, t: 12, b: 28 };
    const xs = series.map((p) => p.at.getTime()), ys = series.map((p) => toEcon(p.lp100, unit));
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    const pad = (y1 - y0 || 1) * 0.15; y0 -= pad; y1 += pad;
    const X = (x) => P.l + ((x - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
    const Y = (y) => H - P.b - ((y - y0) / (y1 - y0)) * (H - P.t - P.b);
    const path = xs.map((x, i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(' ');
    const area = `${path} L${X(x1).toFixed(1)},${H - P.b} L${X(x0).toFixed(1)},${H - P.b} Z`;
    const label = `Economy in ${UNIT[unit]} for ${series.length} intervals from ${date(series[0].at)} to ${date(series.at(-1).at)}, ranging ${num(Math.min(...ys), 1)} to ${num(Math.max(...ys), 1)}.`;
    return s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label },
      s('defs', {},
        s('linearGradient', { id: 'demo-stroke', gradientUnits: 'userSpaceOnUse', x1: P.l, y1: 0, x2: W - P.r, y2: 0 }, s('stop', { offset: 0, class: 'stop-a' }), s('stop', { offset: 1, class: 'stop-b' })),
        s('linearGradient', { id: 'demo-fill', x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: 0, class: 'fill-a' }), s('stop', { offset: 1, class: 'fill-b' }))),
      [0, 0.5, 1].map((t) => y0 + t * (y1 - y0)).map((t) => [s('line', { class: 'axis', x1: P.l, x2: W - P.r, y1: Y(t), y2: Y(t) }), s('text', { x: P.l - 6, y: Y(t) + 4, 'text-anchor': 'end' }, num(t, 1))]),
      s('text', { x: P.l, y: H - 8 }, date(series[0].at)), s('text', { x: W - P.r, y: H - 8, 'text-anchor': 'end' }, date(series.at(-1).at)),
      s('path', { class: 'area', d: area, fill: 'url(#demo-fill)' }),
      s('path', { class: 'line', d: path, pathLength: 1, stroke: 'url(#demo-stroke)' }),
      series.map((p, i) => s('circle', { class: `dot${i === series.length - 1 ? ' last' : ''}`, cx: X(xs[i]), cy: Y(ys[i]), r: 3.5 }, s('title', {}, `${date(p.at)}: ${num(ys[i], 2)} ${UNIT[unit]}`))));
  }

  render();
})();
