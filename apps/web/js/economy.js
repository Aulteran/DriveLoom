// Exact decimal arithmetic, unit conversion, full-to-full economy and the
// fill-up checks, for the client. A line-by-line port of the server's
// apps/api/src/decimal.ts, units.ts, fuel/economy.ts and the parts of
// fuel/service.ts that decide a new fill-up's interval and odometer order, so
// a preview shown before saving is the figure the server will report.
// apps/api/tests/economy-parity.test.ts holds the two to the same results.
//
// Pure: no DOM, no imports. Values are rationals over BigInt; rounding happens
// once, half away from zero. JS numbers are never used for a stored or shown
// quantity, money or economy.

const DECIMAL_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

export class Dec {
  constructor(n, d) { this.n = n; this.d = d; } // d always > 0

  static isDecimal(v) { return typeof v === 'string' && v.length <= 40 && DECIMAL_RE.test(v); }

  /** Parse a contract decimal string. Throws on anything else (including JS numbers). */
  static parse(v) {
    if (!Dec.isDecimal(v)) throw new TypeError('not an exact decimal string');
    const neg = v.startsWith('-');
    const [int, frac = ''] = (neg ? v.slice(1) : v).split('.');
    const n = BigInt(int + frac);
    return new Dec(neg ? -n : n, 10n ** BigInt(frac.length));
  }

  static int(v) { return new Dec(BigInt(v), 1n); }

  add(o) { return new Dec(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Dec(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Dec(this.n * o.n, this.d * o.d); }
  div(o) {
    if (o.n === 0n) throw new RangeError('division by zero');
    return o.n < 0n ? new Dec(-this.n * o.d, this.d * -o.n) : new Dec(this.n * o.d, this.d * o.n);
  }
  cmp(o) {
    const l = this.n * o.d, r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  isZero() { return this.n === 0n; }
  isNegative() { return this.n < 0n; }

  /** Round half away from zero to `scale` fractional digits. */
  toFixed(scale) {
    const m = 10n ** BigInt(scale);
    const neg = this.n < 0n;
    const abs = neg ? -this.n : this.n;
    const q = (abs * m * 2n + this.d) / (this.d * 2n); // floor(x + 1/2) on the magnitude
    const s = q.toString().padStart(scale + 1, '0');
    const out = scale === 0 ? s : `${s.slice(0, -scale)}.${s.slice(-scale)}`;
    return (neg && q !== 0n ? '-' : '') + out;
  }

  /** Shortest exact form when the value terminates within `maxScale` digits, otherwise rounded to it. */
  toDecimal(maxScale) {
    const s = this.toFixed(maxScale);
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  }
}
Dec.ZERO = Dec.int(0);

/** Number of fractional digits in a decimal string. */
export function scaleOf(v) {
  const i = v.indexOf('.');
  return i < 0 ? 0 : v.length - i - 1;
}

// ---------- units (apps/api/src/units.ts) ----------
export const KM_PER = { km: Dec.int(1), mi: Dec.parse('1.609344') };
export const L_PER = { l: Dec.int(1), gal_us: Dec.parse('3.785411784'), gal_imp: Dec.parse('4.54609') };
export const toKm = (v, unit) => v.mul(KM_PER[unit]);
export const fromKm = (km, unit) => km.div(KM_PER[unit]);
export const toLitres = (v, unit) => v.mul(L_PER[unit]);
export const fromLitres = (l, unit) => l.div(L_PER[unit]);

/** Economy from distance and volume, or null when it is not defined. */
export function economy(distanceKm, volumeL, unit) {
  if (distanceKm.cmp(Dec.ZERO) <= 0 || volumeL.cmp(Dec.ZERO) <= 0) return null;
  switch (unit) {
    case 'l_per_100km': return volumeL.mul(Dec.int(100)).div(distanceKm);
    case 'km_per_l': return distanceKm.div(volumeL);
    case 'mpg_us': return fromKm(distanceKm, 'mi').div(fromLitres(volumeL, 'gal_us'));
    case 'mpg_imp': return fromKm(distanceKm, 'mi').div(fromLitres(volumeL, 'gal_imp'));
    default: return null;
  }
}

/** Display scales (fractional digits). Rounding happens only here. */
export const DISPLAY_SCALE = { distance: 1, volume: 2, economy: 2 };

/** Consumption units are better when lower; distance-per-fuel units when higher. */
export const lowerIsBetter = (unit) => unit === 'l_per_100km';

// The database keeps odometer_km at 6 and volume_l at 9 fractional digits, and
// the server computes from those stored values, so the client rounds the same way.
export const storedKm = (value, unit) => Dec.parse(toKm(Dec.parse(value), unit).toFixed(6));
export const storedLitres = (value, unit) => Dec.parse(toLitres(Dec.parse(value), unit).toFixed(9));

// ---------- input ----------
/** What a person typed, as a contract decimal candidate: trimmed, a locale comma made a point. */
export const normalizeDecimal = (s) => String(s ?? '').trim().replace(/,/g, '.');

/** Field rules, as apps/api/src/fuel/service.ts parseFillUp applies them. */
export const RULES = {
  odometer: { maxScale: 3, max: '9999999' },
  volume: { maxScale: 3, max: '100000', positive: true },
  amount: { maxScale: 4, max: '1000000000' },
  exchangeRate: { maxScale: 10, max: '1000000000', positive: true },
  reportingAmount: { maxScale: 4, max: '1000000000' },
};

/**
 * The server's decimal() check. Returns null when `v` is acceptable, else the
 * failing rule: 'format' | 'scale' | 'negative' | 'zero' | 'too_large'.
 */
export function checkDecimal(v, o) {
  if (!Dec.isDecimal(v)) return 'format';
  if (scaleOf(v) > o.maxScale) return 'scale';
  const d = Dec.parse(v);
  if (d.isNegative()) return 'negative';
  if (o.positive && d.isZero()) return 'zero';
  if (d.cmp(Dec.parse(o.max)) > 0) return 'too_large';
  return null;
}

/** The server's occurredAt bounds: at most a day ahead of `now`, and not before 1900. */
export function checkOccurredAt(date, now = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'format';
  if (date.getTime() > now.getTime() + 86_400_000) return 'future';
  if (date.getUTCFullYear() < 1900) return 'past';
  return null;
}

// ---------- full-to-full economy (apps/api/src/fuel/economy.ts) ----------
/** Sentinel id for a fill-up not yet saved: the server's uuidv7 sorts after every existing id. */
export const DRAFT_ID = 'ffffffff-ffff-7fff-bfff-ffffffffffff';

/**
 * One entry per full fill. `fills` are in authoritative order (occurredAt,
 * odometerKm, id). The starting fill is excluded; intervening partial
 * purchases and the closing fill are included.
 */
export function intervals(fills) {
  const out = [];
  let anchor = null;
  let volume = Dec.ZERO, cost = Dec.ZERO, missed = false;
  for (const f of fills) {
    if (f.missedPrevious) missed = true;
    if (anchor) {
      volume = volume.add(f.volumeL);
      cost = cost && f.reportingCost ? cost.add(f.reportingCost) : null;
    }
    if (!f.full) continue;
    if (!anchor) {
      out.push({ endId: f.id, startId: null, endAt: f.occurredAt, available: false, reason: 'no_previous_full_fill', distanceKm: Dec.ZERO, volumeL: Dec.ZERO, cost: null });
    } else {
      const distanceKm = f.odometerKm.sub(anchor.odometerKm);
      const reason = missed ? 'missed_fill' : distanceKm.cmp(Dec.ZERO) <= 0 ? 'no_distance' : null;
      out.push({ endId: f.id, startId: anchor.id, endAt: f.occurredAt, available: reason === null, reason, distanceKm, volumeL: volume, cost });
    }
    anchor = f; volume = Dec.ZERO; cost = Dec.ZERO; missed = false;
  }
  return out;
}

/** A fill-up from the API (FillUp schema), as the server's economy sees its stored row. */
export function fillFromApi(f) {
  return {
    id: f.id, occurredAt: new Date(f.occurredAt),
    odometerKm: storedKm(f.odometer.value, f.odometer.unit), volumeL: storedLitres(f.volume.value, f.volume.unit),
    full: f.full, missedPrevious: f.missedPrevious,
    reportingCost: f.cost ? Dec.parse(f.cost.reportingAmount) : null,
  };
}

/**
 * A fill-up being entered, as the server would store it. `draft`:
 * { occurredAt: Date|string, odometer: {value, unit}, volume: {value, unit}, full, missedPrevious }
 * with contract decimal strings. Throws TypeError on a value that is not one.
 */
export function fillFromDraft(draft) {
  return {
    id: DRAFT_ID, occurredAt: new Date(draft.occurredAt),
    odometerKm: storedKm(draft.odometer.value, draft.odometer.unit), volumeL: storedLitres(draft.volume.value, draft.volume.unit),
    full: draft.full !== false, missedPrevious: draft.missedPrevious === true, reportingCost: null,
  };
}

/** Authoritative order: occurred_at, odometer_km, id. */
function byOrder(a, b) {
  const t = a.occurredAt.getTime() - b.occurredAt.getTime();
  if (t) return t < 0 ? -1 : 1;
  const k = a.odometerKm.cmp(b.odometerKm);
  if (k) return k;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The server's intervalView: figures in the viewer's display units, rounded once. */
function intervalView(i, prefs) {
  if (!i.available) return { available: false, reason: i.reason, distance: null, volume: null, economy: null };
  const e = economy(i.distanceKm, i.volumeL, prefs.economyUnit);
  return {
    available: true, reason: null,
    distance: { value: fromKm(i.distanceKm, prefs.distanceUnit).toFixed(DISPLAY_SCALE.distance), unit: prefs.distanceUnit },
    volume: { value: fromLitres(i.volumeL, prefs.volumeUnit).toFixed(DISPLAY_SCALE.volume), unit: prefs.volumeUnit },
    economy: e && { value: e.toFixed(DISPLAY_SCALE.economy), unit: prefs.economyUnit },
  };
}

/**
 * The `interval` the server will return for `draft` once saved next to the
 * vehicle's `existing` fill-ups (API FillUp objects, any order), in `prefs`
 * ({ distanceUnit, volumeUnit, economyUnit }). A partial fill has no figure
 * until a full fill closes its interval: { available: false, reason: 'partial_fill' }.
 */
export function previewInterval(existing, draft, prefs) {
  const mine = fillFromDraft(draft);
  if (!mine.full) return { available: false, reason: 'partial_fill', distance: null, volume: null, economy: null };
  const fills = [...existing.map(fillFromApi), mine].sort(byOrder);
  const i = intervals(fills).find((x) => x.endId === DRAFT_ID);
  return intervalView(i, prefs);
}

/**
 * The server's odometer order check for a new fill-up: a reading may not be
 * lower than any record before it in time, or higher than any record after
 * it. Returns null, or { code: 'odometer_out_of_sequence', detail, bound:
 * 'lower'|'higher', limit } where `detail` is the server's own message.
 */
export function checkSequence(existing, draft) {
  const at = new Date(draft.occurredAt).getTime();
  const unit = draft.odometer.unit;
  let lo = null, hi = null;
  for (const f of existing) {
    const t = new Date(f.occurredAt).getTime();
    const km = storedKm(f.odometer.value, f.odometer.unit);
    if (t < at && (lo === null || km.cmp(lo) > 0)) lo = km;
    if (t > at && (hi === null || km.cmp(hi) < 0)) hi = km;
  }
  const km = storedKm(draft.odometer.value, unit);
  const show = (v) => `${fromKm(v, unit).toDecimal(1)} ${unit}`;
  if (lo !== null && km.cmp(lo) < 0) return { code: 'odometer_out_of_sequence', bound: 'lower', limit: show(lo), detail: `The odometer reading is lower than an earlier record (${show(lo)}).` };
  if (hi !== null && km.cmp(hi) > 0) return { code: 'odometer_out_of_sequence', bound: 'higher', limit: show(hi), detail: `The odometer reading is higher than a later record (${show(hi)}).` };
  return null;
}

/** The latest record in authoritative order, or null. */
export function latestFill(existing) {
  let best = null, bestFill = null;
  for (const f of existing) {
    const x = fillFromApi(f);
    if (!bestFill || byOrder(x, bestFill) > 0) { best = f; bestFill = x; }
  }
  return best;
}

/** Distance from `fromValue` (in `fromUnit`) to `toValue` (in `unit`), shown in `unit` at one decimal. */
export function distanceBetween(fromValue, fromUnit, toValue, unit) {
  return fromKm(storedKm(toValue, unit).sub(storedKm(fromValue, fromUnit)), unit).toDecimal(1);
}

/** Price per volume unit, as a hint only (never stored): amount / volume at `scale` digits. */
export function unitPrice(amount, volume, scale = 3) {
  const v = Dec.parse(volume);
  if (v.isZero()) return null;
  return Dec.parse(amount).div(v).toFixed(scale);
}

/** `a - b` for two display decimals, at `scale` digits. */
export const difference = (a, b, scale = DISPLAY_SCALE.economy) => Dec.parse(a).sub(Dec.parse(b)).toFixed(scale);
