# ADR 0002: Authentication and recovery (milestone 1.2)

Status: proposed defaults. Owner review of the open questions below before 1.3 ships to users.

## Decisions

- **Libraries.** Passkeys: `@simplewebauthn/server`. OIDC: `openid-client` (authorization code with PKCE, ID token validation including `nonce`). SMTP: `nodemailer`. Password hashing: scrypt (N=2^15, r=8, p=1) from `node:crypto`. TOTP (RFC 6238) is about 20 lines on `node:crypto` and has no dependency. All are MIT or MIT-0, compatible with AGPL-3.0-only.
- **Sessions.** Server-side rows, opaque 256-bit random cookie token stored only as SHA-256. Cookie `dl_session`: `HttpOnly; SameSite=Lax; Path=/; Secure` (Secure follows the public origin scheme). Absolute lifetime 30 days, idle timeout 7 days, first-factor-only (`pending`) sessions live 10 minutes and are accepted by one endpoint. Completing the second factor issues a new session. Each session carries a CSRF token that unsafe requests must echo in `X-CSRF-Token`; an `Origin` header that differs from the public origin is rejected on all unsafe requests.
- **Methods coexist.** Password, TOTP (second factor, 10 single-use recovery codes), any number of passkeys (user verification required, so a passkey sign-in is complete) and OIDC identities are independent. Operators can disable password sign-in only when OIDC is configured. Every account must keep at least one primary method (password, passkey or OIDC identity); removal is checked under a row lock so concurrent removals cannot leave none.
- **Sensitive actions.** Adding or removing credentials, starting TOTP enrolment and starting an OIDC link need a session that authenticated in the last 10 minutes (`reauth_required`, cleared through `POST /v1/auth/reauth` with password or TOTP). Changing or removing a credential, changing the password, recovery and TOTP removal revoke other sessions (recovery revokes all).
- **Enumeration.** Login returns one generic 401 for unknown account, wrong password and disabled account, and always runs a password hash. Recovery requests and, when verification is on, registration return the same response whether or not the address exists.
- **Email codes.** 8 digits, HMAC-stored, 15 minute expiry, at most 5 attempts, single use, newer code replaces older. SMTP is optional operator configuration; `DRIVELOOM_REQUIRE_EMAIL_VERIFICATION=1` without SMTP fails at startup, and a send failure at registration rolls back the account (503).
- **Email sign-in codes** (product requirement: admin-configurable email codes after password login). Off by default; `DRIVELOOM_EMAIL_SIGN_IN_CODES=1` with SMTP. They are a second step only for accounts without an authenticator app, which is the stronger factor and always takes precedence. Passkey and OIDC sign-ins are not affected, since both are already complete sign-ins.
- **TOTP.** Secret encrypted at rest (AES-256-GCM, key derived from `DRIVELOOM_SECRET_KEY`), window ±1 step, `last_step` updated atomically so a code is never accepted twice.
- **OIDC.** State is server-side, hashed, single use, 10 minutes, and bound to the browser by a `dl_oidc` cookie (login CSRF defence). Identities key on issuer plus subject. A new account is created only from a verified email and only if registration policy allows. An existing email is never linked automatically (`oidc_link_required`); the owner links from a signed-in, recently authenticated session, and only that same browser session can complete the link.
- **Rate limits.** Database-backed fixed windows (login 10 per account and 30 per IP per 10 minutes, codes 10 per account, registration 10 per IP per hour, recovery 5 per account per hour). Client IP honours `X-Forwarded-For` only from `DRIVELOOM_TRUSTED_PROXIES`.
- **Operator recovery** without SMTP: `DRIVELOOM_NEW_PASSWORD=... node scripts/auth-admin.ts reset-password <email>`, audited, revokes all sessions. Instance admins have no HTTP route to read or change another user's credentials.
- **Audit.** Sign-ins, failures, credential changes, recovery and revocations write `audit_events` without secrets.

- **Bootstrap administrator (decided 2026-11-12).** An empty instance accepts one registration even when registration is `closed`, and that account is the administrator. This is deliberate: a self-hosted instance needs a first account without extra tooling. The risk is an instance that is reachable before its operator registers. Operators who expose it first set `DRIVELOOM_SETUP_TOKEN`; the bootstrap registration must then send the same value as `setup_token` (`setup_token_required` otherwise). The server logs a warning at startup while no account exists and no token is set. OIDC bootstrap is unchanged: the identity provider decides who can sign in.
- **Recovery timing (decided 2026-11-12).** `POST /v1/auth/recovery/request` validates and rate-limits inline, then answers 202. The account lookup, code issue and SMTP send run after the response, so latency does not depend on whether the address has an account. A failed send is logged, never reported to the caller.

## Open questions for the owner

1. Resolved, see "Bootstrap administrator" above.
2. **Registration without SMTP reveals taken emails** (409 `email_taken`). Hiding it needs email delivery, so the choice is usability on small instances versus enumeration. Default: reveal.
3. **Rate-limit lockout.** Per-account login limits let an attacker slow a victim's sign-in for 10 minutes. Alternative: per-account plus IP pair keys, which weakens distributed guessing protection.
4. **Passkey-only accounts reauthenticate by signing in again**, since `reauth` accepts password or TOTP.
5. **Native clients** (phase 3) need a token flow with refresh rotation. Deferred; the cookie session is browser-only.
6. **Account deletion and email change** are not part of this milestone. Account removal belongs with ownership succession in 1.3.
