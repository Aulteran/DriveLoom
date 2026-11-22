// Touch economy chart for the phone screens. The desktop chart (views/chart.js)
// shows a hover tooltip that vanishes as soon as a finger lifts; here a tap or
// a sideways drag anywhere on the plot picks the nearest interval, and the pick
// stays until the next one. The value is read out in a live line under the
// plot, with previous/next buttons for keyboards and switch access, and the
// collapsed data table from views/chart.js is the exact text alternative.
// Number() is used for geometry only; every printed value is the server's string.
import { h, s } from '../ui.js';
import { UNIT, date } from '../format.js';
import { icon } from '../icons.js';
import { niceTicks, tickText, dataTable } from '../views/chart.js';

let seq = 0;

/**
 * `series`: [{ at, economy }] oldest first (VehicleStats.series); `unit`: the
 * economy unit. Options: `height` of the plot in px, `average` (a decimal
 * string drawn as a dashed reference line), `caption` for the data table.
 */
export function touchEconomyChart(series, unit, { height = 190, average = null, caption } = {}) {
  const u = UNIT[unit] ?? unit;
  if (series.length < 2) {
    return h('p', { class: 'm-chart-empty' }, series.length
      ? `One interval so far: ${series[0].economy} ${u} on ${date(series[0].at)}. The trend appears after the next full fill.`
      : 'The trend appears once two full-to-full intervals close in this period.');
  }
  const id = `mc${++seq}`;
  const P = { l: 38, r: 14, t: 14, b: 26 };
  const xs = series.map((p) => Date.parse(p.at));
  const ys = series.map((p) => Number(p.economy));
  const refs = average ? [...ys, Number(average)] : ys;
  const lo = Math.min(...refs), hi = Math.max(...refs);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.18;
  const ticks = niceTicks(Math.max(0, lo - pad), hi + pad, 3);
  const [y0, y1] = [ticks[0], ticks.at(-1)];
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];

  let width = 340;
  let selected = series.length - 1;
  let X = () => 0, Y = () => 0;
  let marker = null, guide = null;

  const lowest = series.reduce((b, p, i) => (ys[i] < ys[b] ? i : b), 0);
  const highest = series.reduce((b, p, i) => (ys[i] > ys[b] ? i : b), 0);
  const summary = `Economy in ${u} for ${series.length} intervals from ${date(series[0].at)} to ${date(series.at(-1).at)}. `
    + `Lowest ${series[lowest].economy} on ${date(series[lowest].at)}, highest ${series[highest].economy} on ${date(series[highest].at)}.`
    + (average ? ` Period average ${average}.` : '');

  const plot = h('div', { class: 'm-chart-plot' });
  const readValue = h('strong', { class: 'm-chart-value' });
  const readDate = h('span', { class: 'm-chart-date' });
  const readout = h('p', { class: 'm-chart-readout', 'aria-live': 'polite', 'aria-atomic': 'true' }, readValue, readDate);
  const prev = h('button', { type: 'button', class: 'm-icon-btn m-chart-step', 'aria-label': 'Previous interval', onclick: () => pick(selected - 1) }, icon('back'));
  const next = h('button', { type: 'button', class: 'm-icon-btn m-chart-step', 'aria-label': 'Next interval', onclick: () => pick(selected + 1) }, icon('next'));

  function draw() {
    const W = width, H = height;
    X = (x) => P.l + ((x - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
    Y = (y) => H - P.b - ((y - y0) / (y1 - y0 || 1)) * (H - P.t - P.b);
    const pts = series.map((_, i) => `${X(xs[i]).toFixed(1)},${Y(ys[i]).toFixed(1)}`);
    const line = `M${pts.join(' L')}`;
    const area = `${line} L${X(xs.at(-1)).toFixed(1)},${H - P.b} L${X(xs[0]).toFixed(1)},${H - P.b} Z`;
    guide = s('line', { class: 'm-chart-guide', x1: 0, x2: 0, y1: P.t, y2: H - P.b });
    marker = s('circle', { class: 'm-chart-sel', r: 6, cx: 0, cy: 0 });
    const svg = s('svg', { class: 'm-chart-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': summary },
      s('defs', {}, s('linearGradient', { id: `${id}-fill`, x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: 0, class: 'm-chart-fa' }), s('stop', { offset: 1, class: 'm-chart-fb' }))),
      ticks.map((t) => [
        s('line', { class: 'm-chart-grid', x1: P.l, x2: W - P.r, y1: Y(t), y2: Y(t) }),
        s('text', { class: 'm-chart-tick', x: P.l - 7, y: Y(t) + 4, 'text-anchor': 'end' }, tickText(t)),
      ]),
      s('text', { class: 'm-chart-tick', x: P.l, y: H - 6 }, date(series[0].at)),
      s('text', { class: 'm-chart-tick', x: W - P.r, y: H - 6, 'text-anchor': 'end' }, date(series.at(-1).at)),
      average ? s('line', { class: 'm-chart-avg', x1: P.l, x2: W - P.r, y1: Y(Number(average)), y2: Y(Number(average)) }) : null,
      s('path', { class: 'm-chart-area', d: area, fill: `url(#${id}-fill)` }),
      s('path', { class: 'm-chart-line', d: line }),
      series.map((_, i) => s('circle', { class: 'm-chart-dot', cx: X(xs[i]), cy: Y(ys[i]), r: series.length > 40 ? 0 : 3 })),
      guide, marker);
    plot.replaceChildren(svg);
    pick(selected, false);
  }

  function pick(i, announce = true) {
    selected = Math.max(0, Math.min(series.length - 1, i));
    const x = X(xs[selected]), y = Y(ys[selected]);
    guide.setAttribute('x1', x); guide.setAttribute('x2', x);
    marker.setAttribute('cx', x); marker.setAttribute('cy', y);
    const p = series[selected];
    const text = [`${p.economy} ${u}`, date(p.at)];
    if (announce || !readValue.textContent) { readValue.textContent = text[0]; readDate.textContent = ` · ${text[1]}`; }
    prev.disabled = selected === 0;
    next.disabled = selected === series.length - 1;
  }

  // The nearest point to a horizontal position on the plot.
  const nearest = (clientX) => {
    const r = plot.getBoundingClientRect();
    const px = clientX - r.left;
    let best = 0;
    for (let i = 1; i < series.length; i++) if (Math.abs(X(xs[i]) - px) < Math.abs(X(xs[best]) - px)) best = i;
    return best;
  };
  let dragging = false;
  plot.addEventListener('pointerdown', (e) => { dragging = true; pick(nearest(e.clientX)); });
  plot.addEventListener('pointermove', (e) => { if (dragging || e.pointerType === 'mouse') pick(nearest(e.clientX)); });
  const stop = () => { dragging = false; };
  plot.addEventListener('pointerup', stop);
  plot.addEventListener('pointercancel', stop);
  plot.addEventListener('pointerleave', stop);

  draw();
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w < 120 || Math.abs(w - width) < 2) return;
      width = w;
      draw();
    }).observe(plot);
  }
  return h('div', { class: 'm-chart' }, plot,
    h('div', { class: 'm-chart-bar' }, prev, readout, next),
    dataTable(caption ?? `Economy per interval (${u}), oldest first.`, ['Interval ending', `Economy (${u})`], series.map((p) => [date(p.at), p.economy])));
}
