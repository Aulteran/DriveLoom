// Instance policy and operator configuration for authentication.
import { createHash } from 'node:crypto';
import { trustFromList, type IpTrust } from '../http/ip.ts';

export interface OidcConfig { issuer: string; clientId: string; clientSecret: string; redirectUri: string }

export interface AuthConfig {
  /** Public origin, e.g. https://driveloom.example. Used for WebAuthn and Origin checks. */
  publicOrigin: string;
  /** WebAuthn relying party id (a registrable suffix of the origin's host). Stable once passkeys exist. */
  rpId: string;
  rpName: string;
  secureCookies: boolean;
  /** 'open' allows self-registration; 'closed' only the bootstrap first user. */
  registration: 'open' | 'closed';
  passwordEnabled: boolean;
  /** Takes effect only when SMTP is configured; config loading fails otherwise. */
  requireEmailVerification: boolean;
  oidc: OidcConfig | null;
  /** Registration of new accounts through OIDC (when registration is open). */
  /** 32-byte key for TOTP secrets at rest and code HMACs. */
  secretKey: Buffer;
  ipTrust: IpTrust;
  sessionTtlMs: number;
  sessionIdleMs: number;
  pendingTtlMs: number;
  reauthWindowMs: number;
  codeTtlMs: number;
  maxCodeAttempts: number;
  minPasswordLength: number;
}

export function defaultConfig(over: Partial<AuthConfig> & Pick<AuthConfig, 'publicOrigin' | 'secretKey'>): AuthConfig {
  const host = new URL(over.publicOrigin).hostname;
  return {
    rpId: host,
    rpName: 'DriveLoom',
    secureCookies: over.publicOrigin.startsWith('https:'),
    registration: 'closed',
    passwordEnabled: true,
    requireEmailVerification: false,
    oidc: null,
    ipTrust: trustFromList([]),
    sessionTtlMs: 30 * 86_400_000,
    sessionIdleMs: 7 * 86_400_000,
    pendingTtlMs: 10 * 60_000,
    reauthWindowMs: 10 * 60_000,
    codeTtlMs: 15 * 60_000,
    maxCodeAttempts: 5,
    minPasswordLength: 12,
    ...over,
  };
}

/** Load from environment. Throws on inconsistent policy so misconfiguration fails at startup. */
export function configFromEnv(env: Record<string, string | undefined>, smtpConfigured: boolean): AuthConfig {
  const origin = env['DRIVELOOM_PUBLIC_ORIGIN'];
  if (!origin) throw new Error('DRIVELOOM_PUBLIC_ORIGIN is required');
  const u = new URL(origin);
  if (u.origin !== origin) throw new Error('DRIVELOOM_PUBLIC_ORIGIN must be an origin with no path or trailing slash');
  const secret = env['DRIVELOOM_SECRET_KEY'];
  if (!secret || secret.length < 32) throw new Error('DRIVELOOM_SECRET_KEY must be at least 32 characters');
  const requireEmailVerification = env['DRIVELOOM_REQUIRE_EMAIL_VERIFICATION'] === '1';
  if (requireEmailVerification && !smtpConfigured) throw new Error('DRIVELOOM_REQUIRE_EMAIL_VERIFICATION=1 needs SMTP (DRIVELOOM_SMTP_URL and DRIVELOOM_SMTP_FROM)');
  const registration = env['DRIVELOOM_REGISTRATION'] === 'open' ? 'open' : 'closed';
  const issuer = env['DRIVELOOM_OIDC_ISSUER'];
  const oidc = issuer
    ? { issuer, clientId: need(env, 'DRIVELOOM_OIDC_CLIENT_ID'), clientSecret: need(env, 'DRIVELOOM_OIDC_CLIENT_SECRET'), redirectUri: `${origin}/v1/auth/oidc/callback` }
    : null;
  const passwordEnabled = env['DRIVELOOM_PASSWORD_LOGIN'] !== '0';
  if (!passwordEnabled && !oidc) throw new Error('password login disabled without OIDC leaves no primary sign-in method (passkeys alone cannot bootstrap)');
  return defaultConfig({
    publicOrigin: origin,
    rpId: env['DRIVELOOM_RP_ID'] ?? u.hostname,
    secretKey: createHash('sha256').update(secret).digest(),
    registration,
    requireEmailVerification,
    passwordEnabled,
    oidc,
    secureCookies: u.protocol === 'https:',
    ipTrust: trustFromList((env['DRIVELOOM_TRUSTED_PROXIES'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  });
}
function need(env: Record<string, string | undefined>, k: string): string {
  const v = env[k];
  if (!v) throw new Error(`${k} is required when OIDC is configured`);
  return v;
}
