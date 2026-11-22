// Small dependency-free SVG charts. Number() is used for geometry only: every
// value printed (tooltips, tables, labels) is the server's decimal string.
import { h, s } from '../ui.js';
import { UNIT, date } from '../format.js';

let seq = 0;

/** Round-number ticks from 0 (or `lo`) to at least `hi`. */
export function niceTicks(lo, hi, count = 4) {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= raw) ?? raw;
  const start = Math.floor(lo / step) * step;
  const out = [];
  for (let v = start; v <= hi + step * 0.001; v += step) out.push(Number(v.toFixed(6)));
  if (out.at(-1) < hi) out.push(Number((out.at(-1) + step).toFixed(6)));
  return out;
}
export const tickText = (v) => (Math.abs(v) >= 1000 ? `${Number((v / 1000).toFixed(1))}k` : String(Number(v.toFixed(2))));

/**
 * Wraps a chart with a hover tooltip; any element with data-tip gets one.
 * `build(width)` draws the SVG at its real pixel width, so text and marks keep
 * their size on every screen; it is redrawn when the frame is resized.
 */
function frame(build, table) {
  const tip = h('div', { class: 'chart-tip', 'aria-hidden': 'true', hidden: true });
  let width = 640;
  let svg = build(width);
  const wrap = h('div', { class: 'chart-frame' }, svg, tip, table);
  const hide = () => {
    tip.hidden = true;
    svg.querySelector('.guide')?.setAttribute('visibility', 'hidden');
    svg.querySelector('.hover')?.classList.remove('hover');
  };
  wrap.addEventListener('pointerover', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (!t || !svg.contains(t)) return;
    svg.querySelector('.hover')?.classList.remove('hover');
    const mark = t.dataset.mark ? svg.querySelector(`#${t.dataset.mark}`) : null;
    mark?.classList.add('hover');
    tip.replaceChildren(h('strong', {}, t.dataset.tipValue), h('span', {}, t.dataset.tip));
    tip.hidden = false;
    const box = wrap.getBoundingClientRect(), r = (mark ?? t).getBoundingClientRect();
    const x = r.left + r.width / 2 - box.left;
    tip.style.left = `${Math.min(Math.max(x, 70), box.width - 70)}px`;
    tip.style.top = `${r.top - box.top}px`;
    const guide = svg.querySelector('.guide');
    if (guide && t.dataset.x) { guide.setAttribute('x1', t.dataset.x); guide.setAttribute('x2', t.dataset.x); guide.setAttribute('visibility', 'visible'); }
  });
  wrap.addEventListener('pointerleave', hide);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w < 120 || Math.abs(w - width) < 2) return;
      width = w;
      hide();
      const next = build(width);
      svg.replaceWith(next);
      svg = next;
    }).observe(wrap);
  }
  return wrap;
}

/** A collapsed data table: the accessible, exact alternative to the picture. */
export function dataTable(caption, headers, rows) {
  return h('details', { class: 'chart-data' },
    h('summary', {}, 'Show data'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('caption', { class: 'small muted' }, caption),
      h('thead', {}, h('tr', {}, headers.map((x, i) => h('th', { scope: 'col', class: i ? 'num' : '' }, x)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { class: i ? 'num' : '' }, c))))))));
}

/** Economy over time: a line with a soft area, one point per interval. */
export function economyChart(series, unit) {
  if (series.length < 2) return h('p', { class: 'muted chart-empty' }, 'The chart appears once two complete full-to-full intervals exist.');
  const id = `c${++seq}`;
  const H = 240, P = { l: 44, r: 14, t: 16, b: 28 };
  const build = (W) => {
  const xs = series.map((p) => Date.parse(p.at)), ys = series.map((p) => Number(p.economy));
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const pad = (Math.max(...ys) - Math.min(...ys) || Math.abs(ys[0]) || 1) * 0.2;
  const ticks = niceTicks(Math.max(0, Math.min(...ys) - pad), Math.max(...ys) + pad, 3);
  const [y0, y1] = [ticks[0], ticks.at(-1)];
  const X = (x) => P.l + ((x - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
  const Y = (y) => H - P.b - ((y - y0) / (y1 - y0 || 1)) * (H - P.t - P.b);
  const path = series.map((p, i) => `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(' ');
  const area = `${path} L${X(xs.at(-1)).toFixed(1)},${H - P.b} L${X(xs[0]).toFixed(1)},${H - P.b} Z`;
  const values = series.map((p) => p.economy);
  const desc = `Line chart of economy in ${UNIT[unit]} for ${series.length} intervals from ${date(series[0].at)} to ${date(series.at(-1).at)}.`;
  return s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': desc },
    s('defs', {},
      s('linearGradient', { id: `${id}-stroke`, gradientUnits: 'userSpaceOnUse', x1: P.l, y1: 0, x2: W - P.r, y2: 0 }, s('stop', { offset: 0, class: 'stop-a' }), s('stop', { offset: 1, class: 'stop-b' })),
      s('linearGradient', { id: `${id}-fill`, x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: 0, class: 'fill-a' }), s('stop', { offset: 1, class: 'fill-b' }))),
    ticks.map((t) => [s('line', { class: 'axis', x1: P.l, x2: W - P.r, y1: Y(t), y2: Y(t) }), s('text', { x: P.l - 8, y: Y(t) + 4, 'text-anchor': 'end' }, tickText(t))]),
    s('text', { x: P.l, y: H - 6 }, date(series[0].at)), s('text', { x: W - P.r, y: H - 6, 'text-anchor': 'end' }, date(series.at(-1).at)),
    s('line', { class: 'guide', x1: 0, x2: 0, y1: P.t, y2: H - P.b, visibility: 'hidden' }),
    s('path', { class: 'area', d: area, fill: `url(#${id}-fill)` }),
    s('path', { class: 'line', d: path, pathLength: 1, stroke: `url(#${id}-stroke)` }),
    series.map((p, i) => s('circle', { id: `${id}-p${i}`, class: 'dot', cx: X(xs[i]), cy: Y(ys[i]), r: 4 })),
    // Invisible hit targets, larger than the points.
    series.map((p, i) => s('circle', { class: 'hit', cx: X(xs[i]), cy: Y(ys[i]), r: 14, 'data-tip': date(p.at), 'data-tip-value': `${values[i]} ${UNIT[unit]}`, 'data-mark': `${id}-p${i}`, 'data-x': X(xs[i]).toFixed(1) })));
  };
  return frame(build, dataTable(`Economy per interval (${UNIT[unit]}), oldest first.`, ['Interval ending', `Economy (${UNIT[unit]})`], series.map((p) => [date(p.at), p.economy])));
}

/**
 * Vertical bars, one per bucket. `items` are { label, long, value (number for
 * geometry), text (exact string to print) }.
 */
export function barChart({ items, label, unitLabel, tick = tickText, empty = 'No data in this period yet.' }) {
  if (!items.some((it) => it.value > 0)) return h('p', { class: 'muted chart-empty' }, empty);
  const id = `c${++seq}`;
  const H = 220, P = { l: 52, r: 8, t: 14, b: 28 };
  const ticks = niceTicks(0, Math.max(...items.map((it) => it.value)), 3);
  const top = ticks.at(-1);
  const Y = (y) => H - P.b - (y / top) * (H - P.t - P.b);
  const build = (W) => {
  const slot = (W - P.l - P.r) / items.length;
  const bw = Math.max(4, Math.min(44, slot * 0.62));
  const bar = (x, y, w, hgt) => {
    const r = Math.min(4, w / 2, hgt);
    return `M${x},${y + hgt} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + hgt} Z`;
  };
  return s('svg', { class: 'chart bars', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `Bar chart of ${label} for ${items.length} periods from ${items[0].long} to ${items.at(-1).long}.` },
    ticks.map((t) => [s('line', { class: t === 0 ? 'axis base' : 'axis', x1: P.l, x2: W - P.r, y1: Y(t), y2: Y(t) }), s('text', { x: P.l - 8, y: Y(t) + 4, 'text-anchor': 'end' }, tick(t))]),
    items.map((it, i) => {
      const cx = P.l + slot * i + slot / 2;
      const hgt = Math.max(0, H - P.b - Y(it.value));
      return [
        hgt > 0 ? s('path', { id: `${id}-b${i}`, class: `bar-mark${i === items.length - 1 ? ' latest' : ''}`, d: bar(cx - bw / 2, Y(it.value), bw, hgt) }) : null,
        // Label every other bucket when space is tight.
        slot >= 44 || i % 2 === (items.length - 1) % 2 ? s('text', { x: cx, y: H - 8, 'text-anchor': 'middle' }, it.label) : null,
        s('rect', { class: 'hit', x: cx - slot / 2, y: P.t, width: slot, height: H - P.t - P.b, 'data-tip': it.long, 'data-tip-value': it.text, 'data-mark': hgt > 0 ? `${id}-b${i}` : undefined }),
      ];
    }));
  };
  return frame(build, dataTable(`${label}.`, ['Period', unitLabel], items.map((it) => [it.long, it.text])));
}
