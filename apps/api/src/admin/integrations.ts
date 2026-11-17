// Administrator-managed SMTP and OIDC settings. Environment variables, when
// set, win and make the matching page read-only; otherwise the saved settings
// (table integration_settings) apply, and changes take effect immediately
// without a restart. Secrets are encrypted with the instance secret key and
// never leave this module in clear text except to build the transport.
import type { Db } from '../db.ts';
import { HttpProblem } from '../http/problem.ts';
import { invalid, obj } from '../http/validate.ts';
import { createOidcProvider } from '../auth/oidc.ts';
import { createSmtpMailer, createSmtpMailerFromOptions, type Mailer, type SmtpOptions, type SmtpSecurity } from '../auth/mailer.ts';
import type { OidcConfig } from '../auth/config.ts';
import type { OidcProvider } from '../auth/context.ts';
import { decryptSecret, encryptSecret } from '../auth/crypto.ts';

export type Source = 'env' | 'database' | 'none';
export interface Factories { mailer(o: SmtpOptions): Mailer; oidc(c: OidcConfig): OidcProvider }
export const defaultFactories: Factories = { mailer: createSmtpMailerFromOptions, oidc: createOidcProvider };

interface SmtpRow { host: string; port: number; security: SmtpSecurity; username: string | null; from: string }
interface OidcRow { issuer: string; clientId: string }
type Stored<T> = { config: T; secret: string | null; unreadable: boolean };

export interface SmtpView { source: Source; configured: boolean; host: string; port: number; security: SmtpSecurity; username: string; from: string; hasPassword: boolean; secretUnreadable: boolean }
export interface OidcView { source: Source; configured: boolean; issuer: string; clientId: string; hasClientSecret: boolean; secretUnreadable: boolean; redirectUri: string }

const SECURITY: readonly string[] = ['tls', 'starttls', 'none'];
const clean = (v: unknown, what: string, max: number, required: boolean): string => {
  if (v === undefined || v === null || v === '') { if (required) throw invalid(`${what} is required.`); return ''; }
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw invalid(`${what} must be text of at most ${max} characters with no control characters.`);
  return v.trim();
};

export function parseSmtp(body: unknown): { settings: SmtpRow; password: string | null | undefined } {
  const b = obj(body, ['host', 'port', 'security', 'username', 'password', 'from']);
  const host = clean(b['host'], 'host', 253, true);
  if (!/^[A-Za-z0-9._-]+$|^\[[0-9A-Fa-f:.]+\]$/.test(host)) throw invalid('host must be a host name or IP address.');
  const port = b['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw invalid('port must be a whole number from 1 to 65535.');
  const security = b['security'];
  if (typeof security !== 'string' || !SECURITY.includes(security)) throw invalid("security must be 'tls', 'starttls' or 'none'.");
  const from = clean(b['from'], 'from', 254, true);
  if (!/^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$|^[^<>@\r\n]*<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>$/.test(from)) throw invalid('from must be an address such as noreply@example.com or DriveLoom <noreply@example.com>.');
  const username = clean(b['username'], 'username', 255, false);
  // Omitted keeps the stored password; null or an empty string clears it; text replaces it.
  let password: string | null | undefined;
  if (b['password'] === undefined) password = undefined;
  else if (b['password'] === null || b['password'] === '') password = null;
  else password = clean(b['password'], 'password', 512, true);
  return { settings: { host, port, security: security as SmtpSecurity, username: username || null, from }, password };
}

export function parseOidc(body: unknown): { settings: OidcRow; clientSecret: string | undefined } {
  const b = obj(body, ['issuer', 'clientId', 'clientSecret']);
  const issuer = clean(b['issuer'], 'issuer', 512, true);
  let u: URL;
  try { u = new URL(issuer); } catch { throw invalid('issuer must be a URL.'); }
  if (u.protocol !== 'https:' || u.search || u.hash || u.username) throw invalid('issuer must be an https URL with no query, fragment or credentials.');
  const clientId = clean(b['clientId'], 'clientId', 255, true);
  const clientSecret = b['clientSecret'] === undefined || b['clientSecret'] === '' ? undefined : clean(b['clientSecret'], 'clientSecret', 1024, true);
  return { settings: { issuer, clientId }, clientSecret };
}

/** Issuers compare without a trailing slash, as providers differ on it. */
export const sameIssuer = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

export interface IntegrationEnv { smtp: { url: string; from: string } | null; oidc: OidcConfig | null }

export class Integrations {
  mailer: Mailer | null = null;
  oidc: OidcProvider | null = null;
  private smtp: Stored<SmtpRow> | null = null;
  private oidcStored: Stored<OidcRow> | null = null;

  private readonly db: Db;
  private readonly key: Buffer;
  private readonly origin: string;
  private readonly env: IntegrationEnv;
  private readonly f: Factories;
  constructor(db: Db, key: Buffer, origin: string, env: IntegrationEnv, f: Factories = defaultFactories) {
    this.db = db; this.key = key; this.origin = origin; this.env = env; this.f = f;
  }

  get redirectUri(): string { return `${this.origin}/v1/auth/oidc/callback`; }
  get smtpSource(): Source { return this.env.smtp ? 'env' : this.smtp ? 'database' : 'none'; }
  get oidcSource(): Source { return this.env.oidc ? 'env' : this.oidcStored ? 'database' : 'none'; }
  /** Issuer in force, from either source. */
  get oidcIssuer(): string | null { return this.env.oidc?.issuer ?? this.oidcStored?.config.issuer ?? null; }

  async load(): Promise<void> {
    const { rows } = await this.db.query<{ kind: 'smtp' | 'oidc'; config: unknown; secret_enc: string | null }>('SELECT kind, config, secret_enc FROM integration_settings');
    this.smtp = this.oidcStored = null;
    for (const r of rows) {
      const { secret, unreadable } = this.open(r.secret_enc);
      if (r.kind === 'smtp') this.smtp = { config: r.config as SmtpRow, secret, unreadable };
      else this.oidcStored = { config: r.config as OidcRow, secret, unreadable };
    }
    this.rebuild();
  }

  /** Decrypts a stored secret. `unreadable` marks one this instance's key cannot open, e.g. after a restore onto another key. */
  private open(enc: string | null): { secret: string | null; unreadable: boolean } {
    if (!enc) return { secret: null, unreadable: false };
    try { return { secret: decryptSecret(this.key, enc).toString('utf8'), unreadable: false }; }
    catch { console.warn('a saved integration secret cannot be decrypted with this instance key; enter it again in Administration'); return { secret: null, unreadable: true }; }
  }

  private rebuild(): void {
    if (this.env.smtp) this.mailer = createSmtpMailer(this.env.smtp.url, this.env.smtp.from);
    else if (this.smtp && !this.smtp.unreadable) this.mailer = this.f.mailer(this.smtpOptions(this.smtp));
    else this.mailer = null;
    if (this.env.oidc) this.oidc = this.f.oidc(this.env.oidc);
    else if (this.oidcStored && !this.oidcStored.unreadable && this.oidcStored.secret) this.oidc = this.f.oidc({ ...this.oidcStored.config, clientSecret: this.oidcStored.secret, redirectUri: this.redirectUri });
    else this.oidc = null;
  }
  private smtpOptions(s: Stored<SmtpRow>): SmtpOptions { return { ...s.config, password: s.secret }; }

  smtpView(): SmtpView {
    if (this.env.smtp) return { source: 'env', configured: true, host: '', port: 0, security: 'starttls', username: '', from: this.env.smtp.from, hasPassword: false, secretUnreadable: false };
    const s = this.smtp;
    return { source: this.smtpSource, configured: !!this.mailer, host: s?.config.host ?? '', port: s?.config.port ?? 587, security: s?.config.security ?? 'starttls', username: s?.config.username ?? '', from: s?.config.from ?? '', hasPassword: !!s?.secret, secretUnreadable: !!s?.unreadable };
  }
  oidcView(): OidcView {
    const base = { redirectUri: this.redirectUri };
    if (this.env.oidc) return { ...base, source: 'env', configured: true, issuer: this.env.oidc.issuer, clientId: this.env.oidc.clientId, hasClientSecret: true, secretUnreadable: false };
    const s = this.oidcStored;
    return { ...base, source: this.oidcSource, configured: !!this.oidc, issuer: s?.config.issuer ?? '', clientId: s?.config.clientId ?? '', hasClientSecret: !!s?.secret, secretUnreadable: !!s?.unreadable };
  }

  static managed(): HttpProblem { return new HttpProblem(409, 'managed_by_environment', 'Conflict', 'This setting is configured by environment variables on the server; change it there.'); }

  async saveSmtp(input: ReturnType<typeof parseSmtp>): Promise<void> {
    if (this.env.smtp) throw Integrations.managed();
    const prev = this.smtp && !this.smtp.unreadable ? this.smtp.secret : null;
    let secret = input.password === undefined ? prev : input.password;
    if (!input.settings.username) secret = null; // a password without a username is never used
    await this.write('smtp', input.settings, secret);
    await this.load();
  }
  async clearSmtp(): Promise<void> {
    if (this.env.smtp) throw Integrations.managed();
    await this.db.query("DELETE FROM integration_settings WHERE kind = 'smtp'");
    await this.load();
  }
  async saveOidc(input: ReturnType<typeof parseOidc>): Promise<void> {
    if (this.env.oidc) throw Integrations.managed();
    const prev = this.oidcStored && !this.oidcStored.unreadable ? this.oidcStored.secret : null;
    const secret = input.clientSecret ?? prev;
    if (!secret) throw invalid('clientSecret is required.');
    await this.write('oidc', input.settings, secret);
    await this.load();
  }
  async clearOidc(): Promise<void> {
    if (this.env.oidc) throw Integrations.managed();
    await this.db.query("DELETE FROM integration_settings WHERE kind = 'oidc'");
    await this.load();
  }
  private async write(kind: 'smtp' | 'oidc', config: object, secret: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO integration_settings (kind, config, secret_enc) VALUES ($1,$2,$3)
       ON CONFLICT (kind) DO UPDATE SET config = EXCLUDED.config, secret_enc = EXCLUDED.secret_enc, updated_at = now()`,
      [kind, config, secret === null ? null : encryptSecret(this.key, Buffer.from(secret, 'utf8'))]);
  }
}
