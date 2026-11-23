// Home (route #/vehicles/:id on the phone): the daily glance for the active
// vehicle. The latest tank leads, then the trend for the chosen period, the key
// figures and the last three fill-ups. At most three requests: the period's
// stats, the previous period's (for the comparison) and five recent fill-ups.
// The friends card uses the count the shell already fetched.
import { get } from '../api.js';
import { state } from '../core.js';
import { h } from '../ui.js';
import { icon } from '../icons.js';
import { qty, money, date, UNIT, ROLE, vehicleTitle, vehicleDescription, canAddFuel, canEditVehicle } from '../format.js';
import { difference, lowerIsBetter } from '../economy.js';
import { DAY, statsUrl } from '../views/vehicle.js';
import { touchEconomyChart } from './chart.js';
import { PERIODS, fillRow, openFillDetail } from './history.js';

const unitText = (u) => UNIT[u] ?? u;

/** Period choice as a segmented row of links; `href(key)` builds each target. */
export function periodControl(current, href, label = 'Period') {
  return h('nav', { class: 'm-seg', 'aria-label': label }, PERIODS.map(([k, long, short]) =>
    // The visible short form starts the name; the long form follows for screen readers.
    h('a', { href: href(k), class: 'm-seg-opt', 'aria-current': k === current ? 'true' : undefined }, short, h('span', { class: 'm-vh' }, `, ${long.toLowerCase()}`))));
}

/** "▲ Worse than …" for economy `a` against `b` (same unit), in words and an arrow as well as colour. */
export function compare(a, b, what) {
  const diff = difference(a.value, b.value);
  const abs = diff.replace(/^-/, '');
  if (/^[0.]+$/.test(abs)) return h('p', { class: 'm-delta' }, `Same as ${what} (${b.value})`);
  const higher = !diff.startsWith('-');
  const better = higher !== lowerIsBetter(a.unit);
  return h('p', { class: `m-delta ${better ? 'm-good' : 'm-bad'}` }, h('span', { 'aria-hidden': 'true' }, better ? '▲ ' : '▼ '),
    `${better ? 'Better' : 'Worse'} than ${what} (${b.value})`);
}

/** Friends, from the count the shell already fetched: no request of its own. */
function friendsCard(friends) {
  return h('section', { class: 'm-card m-pad m-friends', 'aria-labelledby': 'm-fr-h' },
    h('div', { class: 'm-card-head' }, h('h2', { id: 'm-fr-h' }, 'Friends'), h('a', { class: 'm-link', href: '#/friends' }, 'Compare', icon('next', 'icon m-link-next'))),
    h('p', {}, `${friends} ${friends === 1 ? 'friend' : 'friends'} on this server. Compare average economy with the vehicles they share.`),
    h('p', { class: 'm-small m-muted' }, 'Friends never see individual fill-ups, dates or distances.'));
}

function stat(label, value, sub) {
  return h('div', { class: 'm-stat' }, h('dt', {}, label), h('dd', {}, h('span', { class: 'm-stat-v' }, value), sub ? h('span', { class: 'm-stat-sub' }, sub) : null));
}

/** ctx: { query, friends } — `friends` is the accepted-friends count the shell fetched. */
export async function homeScreen(id, { query, friends = 0 }) {
  const v = await get(`/v1/vehicles/${id}`);
  const canEdit = canAddFuel(v) && !v.archived;
  const win = PERIODS.some(([k]) => k === query.get('window')) ? query.get('window') : '90';
  const days = win === 'all' ? null : Number(win);
  const now = Date.now();
  const from = days ? new Date(now - days * DAY) : null;
  const [cur, prev, recent] = await Promise.all([
    get(statsUrl(v, from, null)),
    days ? get(statsUrl(v, new Date(now - 2 * days * DAY), from)).catch(() => null) : null,
    get(`/v1/vehicles/${v.id}/fill-ups?limit=5`),
  ]);
  const periodLong = PERIODS.find(([k]) => k === win)[1];
  const periodShort = days === 365 ? '12-month' : days ? `${days}-day` : 'all-time';
  const sub = [vehicleTitle(v) === vehicleDescription(v) ? '' : vehicleDescription(v), ROLE[v.role], v.archived ? 'Archived' : ''].filter(Boolean).join(' · ');
  const title = h('div', { class: 'm-title-text' }, h('h1', {}, vehicleTitle(v)), sub ? h('p', { class: 'm-sub' }, sub) : null);

  if (!recent.total) {
    return h('div', { class: 'm-screen m-stack m-home' }, title,
      h('section', { class: 'm-card m-empty', 'aria-labelledby': 'm-empty-h' },
        h('span', { class: 'm-empty-art', 'aria-hidden': 'true' }, icon('gauge')),
        h('h2', { id: 'm-empty-h' }, 'No fill-ups yet'),
        h('p', {}, 'Log a fill-up each time you buy fuel. Economy needs two full fills: the first sets the starting point.'),
        canEdit ? h('div', { class: 'm-actions' }, h('a', { class: 'button', href: '#/fill' }, icon('plus'), 'Log a fill-up'), canEditVehicle(v) ? h('a', { class: 'button secondary', href: `#/vehicles/${v.id}/data` }, icon('upload'), 'Import') : null) : null),
      friends > 0 ? friendsCard(friends) : null);
  }

  // ---- latest tank ----
  const latest = recent.items.find((f) => f.interval?.available && f.interval.economy);
  const avg = cur.economy;
  let hero;
  if (latest) {
    const i = latest.interval;
    hero = h('section', { class: 'm-card m-pad m-hero', 'aria-labelledby': 'm-latest-h' },
      h('h2', { class: 'm-label', id: 'm-latest-h' }, `Latest tank · ${date(latest.occurredAt)}`),
      h('p', { class: 'm-hero-line' }, h('span', { class: 'm-big' }, i.economy.value), h('span', { class: 'm-big-unit' }, unitText(i.economy.unit))),
      h('p', { class: 'm-hero-sub' }, [`${qty(i.distance)} on ${qty(i.volume)}`, latest.cost ? money(latest.cost.amount, latest.cost.currency) : null].filter(Boolean).join(' · ')),
      avg && avg.unit === i.economy.unit ? compare(i.economy, avg, `your ${periodShort} average`) : null);
  } else {
    hero = h('section', { class: 'm-card m-pad m-hero', 'aria-labelledby': 'm-latest-h' },
      h('h2', { class: 'm-label', id: 'm-latest-h' }, 'Latest tank'),
      h('p', { class: 'm-hero-empty' }, 'No figure yet'),
      h('p', { class: 'm-hero-sub' }, 'Economy appears once a full fill closes an interval: fill the tank completely, then again next time.'));
  }

  // ---- trend ----
  const eUnit = avg?.unit ?? state.prefs?.economyUnit ?? 'l_per_100km';
  const trend = h('section', { class: 'm-card m-pad', 'aria-labelledby': 'm-trend-h' },
    h('div', { class: 'm-card-head' }, h('h2', { id: 'm-trend-h' }, 'Economy trend'), h('span', { class: 'm-small m-muted' }, `${unitText(eUnit)} · ${lowerIsBetter(eUnit) ? 'lower' : 'higher'} is better`)),
    touchEconomyChart(cur.series, eUnit, { average: avg?.value ?? null, height: 170 }));

  // ---- key figures ----
  const cpd = cur.costPerDistance;
  const figures = h('section', { class: 'm-figures', 'aria-labelledby': 'm-fig-h' },
    h('h2', { class: 'm-vh', id: 'm-fig-h' }, `Figures for the ${periodLong.toLowerCase()}`),
    h('dl', { class: 'm-stats' },
      stat('Average', avg ? h('span', {}, avg.value, h('span', { class: 'm-stat-u' }, ` ${unitText(avg.unit)}`)) : '—',
        avg ? (prev?.economy && prev.fillCount ? compare(avg, prev.economy, 'the period before') : `${cur.intervalCount} ${cur.intervalCount === 1 ? 'interval' : 'intervals'}`) : 'Needs two full fills'),
      stat('Spent', money(cur.spend.amount, cur.spend.currency), cur.spend.costedFillCount < cur.fillCount ? `${cur.spend.costedFillCount} of ${cur.fillCount} costed` : null),
      stat('Distance', qty(cur.distance)),
      stat('Fuel', qty(cur.volume)),
      stat('Cost per distance', cpd ? `${money(cpd.value, cpd.currency)}/${unitText(cpd.per)}` : '—'),
      stat('Fill-ups', String(cur.fillCount), `${recent.total} in total`)));

  // ---- recent ----
  const recentList = h('section', { class: 'm-stack-s', 'aria-labelledby': 'm-recent-h' },
    h('div', { class: 'm-card-head m-pad-x0' }, h('h2', { id: 'm-recent-h' }, 'Recent fill-ups'), h('a', { class: 'm-link', href: `#/vehicles/${v.id}/log` }, 'See all', icon('next', 'icon m-link-next'))),
    h('ul', { class: 'm-card m-fill-list' }, recent.items.slice(0, 3).map((f) => fillRow(f, (x) => openFillDetail(v, x), { month: true }))));

  return h('div', { class: 'm-screen m-stack m-home' }, title,
    periodControl(win, (k) => `#/vehicles/${v.id}${k === '90' ? '' : `?window=${k}`}`),
    hero, trend, figures, recentList,
    friends > 0 ? friendsCard(friends) : null,
    h('p', { class: 'm-small m-muted m-foot' }, `Figures for the ${periodLong.toLowerCase()}. Averages sum distance and fuel first, then divide; spending counts every costed purchase.`));
}
