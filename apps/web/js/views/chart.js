// Small dependency-free SVG line chart for economy over time.
import { h, s } from '../ui.js';
import { UNIT, date } from '../format.js';

export function economyChart(series, unit) {
  if (series.length < 2) return h('p', { class: 'muted' }, 'The chart appears once two complete full-to-full intervals exist.');
  const W = 640, H = 220, P = { l: 48, r: 12, t: 12, b: 28 };
  const xs = series.map((p) => Date.parse(p.at)), ys = series.map((p) => Number(p.economy));
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const pad = (y1 - y0 || Math.abs(y1) || 1) * 0.15; y0 -= pad; y1 += pad;
  const X = (x) => P.l + ((x - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
  const Y = (y) => H - P.b - ((y - y0) / (y1 - y0)) * (H - P.t - P.b);
  const ticks = [0, 0.5, 1].map((f) => y0 + f * (y1 - y0));
  const path = series.map((p, i) => `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(' ');
  const desc = `Economy in ${UNIT[unit]} for ${series.length} intervals from ${date(series[0].at)} to ${date(series.at(-1).at)}, ranging ${Math.min(...ys)} to ${Math.max(...ys)}.`;
  return s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': desc },
    ticks.map((t) => [s('line', { class: 'axis', x1: P.l, x2: W - P.r, y1: Y(t), y2: Y(t) }), s('text', { x: P.l - 6, y: Y(t) + 4, 'text-anchor': 'end' }, t.toFixed(1))]),
    s('text', { x: P.l, y: H - 8 }, date(series[0].at)), s('text', { x: W - P.r, y: H - 8, 'text-anchor': 'end' }, date(series.at(-1).at)),
    s('path', { class: 'line', d: path }),
    series.map((p, i) => s('circle', { class: 'dot', cx: X(xs[i]), cy: Y(ys[i]), r: 3.5 }, s('title', {}, `${date(p.at)}: ${p.economy} ${UNIT[unit]}`))));
}
