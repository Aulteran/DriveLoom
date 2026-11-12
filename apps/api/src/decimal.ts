// Exact decimal arithmetic for quantities, money and economy (docs/CONTRACTS.md,
// "Decimal rules"). Values are rationals over bigint, so conversions and
// aggregation never lose precision; rounding happens once, in toFixed, half
// away from zero. JS numbers are never used for stored or reported values.
import type { Decimal } from './types.ts';

const DECIMAL_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

export class Dec {
  readonly n: bigint;
  readonly d: bigint; // always > 0
  private constructor(n: bigint, d: bigint) { this.n = n; this.d = d; }

  static readonly ZERO = new Dec(0n, 1n);

  static isDecimal(v: unknown): v is Decimal {
    return typeof v === 'string' && v.length <= 40 && DECIMAL_RE.test(v);
  }

  /** Parse a contract decimal string. Throws on anything else (including JS numbers). */
  static parse(v: unknown): Dec {
    if (!Dec.isDecimal(v)) throw new TypeError('not an exact decimal string');
    const neg = v.startsWith('-');
    const [int, frac = ''] = (neg ? v.slice(1) : v).split('.') as [string, string?];
    const n = BigInt(int + frac);
    return new Dec(neg ? -n : n, 10n ** BigInt(frac.length));
  }

  static int(v: bigint | number): Dec { return new Dec(BigInt(v), 1n); }

  add(o: Dec): Dec { return new Dec(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o: Dec): Dec { return new Dec(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o: Dec): Dec { return new Dec(this.n * o.n, this.d * o.d); }
  div(o: Dec): Dec {
    if (o.n === 0n) throw new RangeError('division by zero');
    return o.n < 0n ? new Dec(-this.n * o.d, this.d * -o.n) : new Dec(this.n * o.d, this.d * o.n);
  }
  cmp(o: Dec): -1 | 0 | 1 {
    const l = this.n * o.d, r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  isZero(): boolean { return this.n === 0n; }
  isNegative(): boolean { return this.n < 0n; }

  /** Round half away from zero to `scale` fractional digits. */
  toFixed(scale: number): Decimal {
    const m = 10n ** BigInt(scale);
    const neg = this.n < 0n;
    const abs = neg ? -this.n : this.n;
    const q = (abs * m * 2n + this.d) / (this.d * 2n); // floor(x + 1/2) on the magnitude
    const s = q.toString().padStart(scale + 1, '0');
    const out = scale === 0 ? s : `${s.slice(0, -scale)}.${s.slice(-scale)}`;
    return ((neg && q !== 0n ? '-' : '') + out) as Decimal;
  }

  /** Shortest exact form when the value terminates within `maxScale` digits, otherwise rounded to it. */
  toDecimal(maxScale: number): Decimal {
    const s = this.toFixed(maxScale);
    return (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s) as Decimal;
  }
}

/** Number of fractional digits in a decimal string. */
export function scaleOf(v: string): number {
  const i = v.indexOf('.');
  return i < 0 ? 0 : v.length - i - 1;
}
