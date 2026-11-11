// Primitives for the auth module: password hashing, token hashing, TOTP,
// secret-at-rest encryption. Built on node:crypto only.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual, type BinaryLike } from 'node:crypto';

const scryptAsync = (pw: BinaryLike, salt: BinaryLike, len: number, o: { N: number; r: number; p: number; maxmem: number }) =>
  new Promise<Buffer>((res, rej) => scrypt(pw, salt, len, o, (e, k) => (e ? rej(e) : res(k))));

const N = 2 ** 15, R = 8, P = 1;

export function randomToken(bytes = 32): string { return randomBytes(bytes).toString('base64url'); }
export function sha256Hex(s: string): string { return createHash('sha256').update(s).digest('hex'); }
export function hmacHex(key: Buffer, label: string, s: string): string { return createHmac('sha256', key).update(`${label}\0${s}`).digest('hex'); }
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, 32, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const got = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2 });
  return timingSafeEqual(got, expected);
}

let dummy: Promise<string> | undefined;
/** A real hash to verify against when the account does not exist, so timing does not reveal it. */
export function dummyHash(): Promise<string> { return (dummy ??= hashPassword('dummy-password-for-timing')); }

// --- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ---
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export const TOTP_PERIOD = 30;
export function totpStep(nowMs: number): number { return Math.floor(nowMs / 1000 / TOTP_PERIOD); }
export function totpCode(secret: Buffer, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1]! & 0xf;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 1_000_000).padStart(6, '0');
}
/** Returns the matching step within ±1 period of now, or null. Caller enforces replay protection. */
export function matchTotp(secret: Buffer, code: string, nowMs: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const cur = totpStep(nowMs);
  let hit: number | null = null;
  for (const s of [cur - 1, cur, cur + 1]) if (safeEqual(totpCode(secret, s), code)) hit = s;
  return hit;
}

// --- secrets at rest (AES-256-GCM) ---
export function encryptSecret(key: Buffer, plain: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return `${iv.toString('base64')}.${ct.toString('base64')}.${c.getAuthTag().toString('base64')}`;
}
export function decryptSecret(key: Buffer, stored: string): Buffer {
  const [iv, ct, tag] = stored.split('.').map((x) => Buffer.from(x ?? '', 'base64'));
  const d = createDecipheriv('aes-256-gcm', key, iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(ct!), d.final()]);
}

/** Uniform numeric code, e.g. for email. */
export function numericCode(digits = 8): string { return String(randomInt(0, 10 ** digits)).padStart(digits, '0'); }
/** Human-friendly recovery code, 10 chars from an unambiguous alphabet. */
export function recoveryCode(): string {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += a[randomInt(a.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
