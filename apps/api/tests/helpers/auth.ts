import { createTestDb, ORIGIN } from './index.ts';
import { defaultConfig, type AuthConfig } from '../../src/auth/config.ts';
import { MemoryMailer } from '../../src/auth/mailer.ts';
import { authenticator } from '../../src/auth/sessions.ts';
import { totpCode, totpStep } from '../../src/auth/crypto.ts';
import * as acct from '../../src/auth/accounts.ts';
import type { AuthContext, OidcClaims, OidcProvider } from '../../src/auth/context.ts';
import type { Principal } from '../../src/identity.ts';

export const PW = 'correct horse battery staple';
export const meta = { ip: '198.51.100.1', userAgent: 'test' };

export class FakeOidc implements OidcProvider {
  claims: OidcClaims = { issuer: 'https://idp.test', subject: 'sub-1', email: 'oidc@example.test', emailVerified: true };
  last: { state: string; nonce: string; codeVerifier: string } | null = null;
  /** Set to make the provider reject the exchange (bad signature, wrong nonce, ...). */
  reject = false;
  async authorizationUrl(a: { state: string; nonce: string; codeVerifier: string }) { this.last = a; return `https://idp.test/auth?state=${a.state}`; }
  async exchange(a: { state: string; nonce: string; codeVerifier: string }) {
    if (this.reject || !this.last || a.nonce !== this.last.nonce || a.codeVerifier !== this.last.codeVerifier) throw new Error('bad id token');
    return this.claims;
  }
}

export interface Harness { ctx: AuthContext; mailer: MemoryMailer; oidc: FakeOidc; clock: { t: number }; auth: ReturnType<typeof authenticator>; drop(): Promise<void>; skip: false }

/** Returns null when no database is configured so tests can skip. */
export async function harness(over: Partial<AuthConfig> = {}, opts: { mail?: boolean } = {}): Promise<Harness | null> {
  const t = await createTestDb();
  if (!t) return null;
  const clock = { t: Date.parse('2026-11-12T10:00:00Z') };
  const mailer = new MemoryMailer();
  const oidc = new FakeOidc();
  const config = defaultConfig({ publicOrigin: ORIGIN, secretKey: Buffer.alloc(32, 7), registration: 'open', secureCookies: true, ...over });
  const ctx: AuthContext = { db: t.pool, config, mailer: opts.mail === false ? null : mailer, oidc, now: () => new Date(clock.t) };
  return { ctx, mailer, oidc, clock, auth: authenticator(ctx), drop: () => t.drop(), skip: false };
}

export async function signUp(h: Harness, email: string, password = PW) {
  await acct.register(h.ctx, { email, password }, meta);
  return acct.login(h.ctx, { email, password }, meta);
}

export async function principalFor(h: Harness, token: string): Promise<Principal> {
  const s = await h.auth.resolveSession(token);
  if (!s?.principal) throw new Error('no active session');
  return s.principal;
}

export async function currentTotp(h: Harness, secretBase32: string): Promise<string> {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, v = 0; const out: number[] = [];
  for (const ch of secretBase32) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return totpCode(Buffer.from(out), totpStep(h.ctx.now().getTime()));
}
export async function nextTotp(h: Harness, secret: string): Promise<string> {
  h.clock.t += 30_000;
  return currentTotp(h, secret);
}
