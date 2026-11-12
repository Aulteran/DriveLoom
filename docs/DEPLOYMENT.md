# Self-hosting DriveLoom

DriveLoom runs as one Node 22 process that serves the API under `/v1` and the web client everywhere else, with PostgreSQL 16 for all data, including vehicle photos. A reverse proxy in front terminates HTTPS. There is no telemetry, analytics or call home.

## Quick start with Docker Compose

1. Copy the example settings and fill them in:

   ```sh
   cp deploy/.env.example deploy/.env
   # DRIVELOOM_PUBLIC_ORIGIN   the https URL people will use, no trailing slash
   # DRIVELOOM_SECRET_KEY      openssl rand -hex 32
   # POSTGRES_PASSWORD         openssl rand -hex 24  (letters and digits only)
   # DRIVELOOM_SETUP_TOKEN     openssl rand -hex 16  (needed to create the first account)
   ```

2. Create the backup folder the container writes to, then start:

   ```sh
   mkdir -p deploy/backups && sudo chown 1000:1000 deploy/backups
   docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build --wait
   ```

   The app listens on `127.0.0.1:8080` of the host (change with `DRIVELOOM_PORT`). PostgreSQL is on an internal network and is not published.

3. Point your reverse proxy at `127.0.0.1:8080` (examples below), open the public URL, and register. The first account becomes the administrator and needs the setup token. After that, registration is closed by default: invite people from **Admin → Invitations**.

Migrations run automatically at start-up. They are forward-only; take a backup before upgrading.

## Run the published image

Every release (a push to `main`) publishes a multi-architecture image (linux/amd64 and linux/arm64) to GitHub Container Registry as `ghcr.io/aulteran/driveloom`, tagged `latest`, with the full commit SHA, and with the version for a pushed `v*` tag. To use it instead of building from source, add this to `deploy/.env` (pin a SHA or version tag for repeatable upgrades):

```sh
DRIVELOOM_IMAGE=ghcr.io/aulteran/driveloom:latest
```

then pull and start without `--build`:

```sh
docker compose -f deploy/compose.yml --env-file deploy/.env pull app
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --wait
```

If the pull is refused as unauthorized, the package is still private: the owner must set it public in the package settings on GitHub, or you can `docker login ghcr.io` with a token that has `read:packages`. Take a backup before upgrading.

## Settings

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes (set by compose) | PostgreSQL connection URL. |
| `DRIVELOOM_PUBLIC_ORIGIN` | yes | The public origin, e.g. `https://fuel.example.com`. Cookies, the CSRF origin check, passkeys and the OIDC callback derive from it. `https:` turns on secure cookies and HSTS. |
| `DRIVELOOM_SECRET_KEY` | yes | At least 32 characters. Keys session and code hashing; changing it signs everyone out. |
| `DRIVELOOM_SETUP_TOKEN` | recommended | At least 16 characters. Required to create the first account. Without it, whoever registers first becomes the administrator, and the server logs a warning while no account exists. |
| `DRIVELOOM_REGISTRATION` | no | `closed` (default; invitation only) or `open`. |
| `DRIVELOOM_TRUSTED_PROXIES` | behind a proxy | Comma-separated IPs or CIDRs whose `X-Forwarded-For` is believed. Rate limits and audit use the resulting client address. Leave empty when nothing sits in front. |
| `DRIVELOOM_RP_ID` | no | WebAuthn relying-party id; defaults to the origin's host name. Changing it invalidates existing passkeys. |
| `DRIVELOOM_SMTP_URL`, `DRIVELOOM_SMTP_FROM` | no | Email for verification and password recovery, e.g. `smtps://user:pass@smtp.example.com`. Without them, recovery is by an administrator (below). |
| `DRIVELOOM_REQUIRE_EMAIL_VERIFICATION` | no | `1` requires a verified email before sign-in. Needs SMTP. |
| `DRIVELOOM_EMAIL_SIGN_IN_CODES` | no | `1` emails a one-time code after a correct password, as a second step for accounts without an authenticator app. Needs SMTP. |
| `DRIVELOOM_OIDC_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET` | no | OpenID Connect sign-in. Register `<origin>/v1/auth/oidc/callback` as the redirect URI. |
| `DRIVELOOM_PASSWORD_LOGIN` | no | `0` disables passwords; only allowed with OIDC configured. |
| `HOST`, `PORT` | no | Listen address; the image uses `0.0.0.0:8080`. Without Docker the default is `127.0.0.1:8080`. |
| `DATABASE_POOL_SIZE` | no | Default 10. |
| `DRIVELOOM_WEB_DIR` | no | Serve the web client from another directory. |

The server refuses to start on inconsistent settings (for example email verification without SMTP), so mistakes show up in the logs at once.

## Reverse proxy

Examples are in `deploy/proxy/`: a `Caddyfile` (automatic certificates) and an `nginx.conf` that also works as the custom location for Nginx Proxy Manager. Whatever you use:

- Serve over HTTPS only, at the exact origin in `DRIVELOOM_PUBLIC_ORIGIN`. Do not serve DriveLoom under a sub-path.
- Pass the `Host` header through, and **replace** `X-Forwarded-For` with the client address rather than appending to it.
- Allow request bodies up to about 10 MB (imports are capped at 8 MiB, photos at 5 MiB).
- Set `DRIVELOOM_TRUSTED_PROXIES` to the address the app sees the proxy connect from. With the compose file and a proxy on the host, that is the Docker bridge gateway of the compose network (`docker network inspect driveloom_default`, the `Gateway` field). A whole range such as `172.16.0.0/12` also works but trusts every container on those networks.

## Backups and restore

Backups are consistent snapshots of everything, including photos, in one compressed file with an integrity checksum. Live sessions are not included, so after a restore everyone signs in again.

```sh
DC="docker compose -f deploy/compose.yml --env-file deploy/.env"
$DC exec app node scripts/backup.ts create /backups/$(date +%F).dl-backup
$DC exec app node scripts/backup.ts verify /backups/2026-11-12.dl-backup
```

Files land in `deploy/backups/` on the host. Copy them somewhere else; they contain password hashes and every record, so keep them private. Run `create` from cron for regular backups.

**Restore drill (recommended after setting up).** Restore into a separate, empty database and look at it before you need it for real:

```sh
$DC exec db psql -U driveloom -c "CREATE DATABASE drill"
$DC exec -e DATABASE_URL=postgres://driveloom:$POSTGRES_PASSWORD@db:5432/drill app \
  node scripts/backup.ts restore /backups/2026-11-12.dl-backup
$DC exec db psql -U driveloom -c "DROP DATABASE drill"
```

**Replacing the live data.** Stop the app, restore with `--replace`, start it again:

```sh
$DC stop app
$DC run --rm app node scripts/backup.ts restore /backups/2026-11-12.dl-backup --replace
$DC start app
```

`--replace` empties the target inside the same transaction as the load, so a failed restore leaves the database exactly as it was. Without `--replace`, restoring into a non-empty database is refused. A backup from an older version is migrated forward during restore; one from a newer version is refused.

## Account recovery without email

An administrator cannot see or set passwords in the web client. From the server:

```sh
$DC exec -e DRIVELOOM_NEW_PASSWORD='a long new passphrase' app node scripts/auth-admin.ts reset-password person@example.com
```

This signs the person out everywhere and writes an audit event. If they had an authenticator app, it stays on; their recovery codes still work.

If every administrator is locked out, reset one of their passwords the same way.

## Upgrading

```sh
git pull
$DC exec app node scripts/backup.ts create /backups/pre-upgrade.dl-backup
$DC up -d --build --wait
```

The new version applies its migrations at start-up. To go back, check out the previous version and restore the pre-upgrade backup with `--replace`; migrations are not reversible.

## Running without Docker

Node 22 (22.18 or later) and PostgreSQL 16:

```sh
cd apps/api && npm ci --omit=dev
DATABASE_URL=postgres://... DRIVELOOM_PUBLIC_ORIGIN=https://fuel.example.com DRIVELOOM_SECRET_KEY=... node src/server.ts
```

It serves `apps/web` automatically. Keep it behind a reverse proxy and a process supervisor such as systemd; it shuts down cleanly on `SIGTERM`.

## What has been verified

On 2026-11-12 the image was built and the compose stack run behind Caddy with an internal TLS certificate: setup-token bootstrap, secure cookies over HTTPS, photo upload, statistics, backup create and verify inside the container, restore into a separate database with identical row counts and photo bytes, rejection of a tampered archive and of a restore over existing data, CLI password reset, and data surviving a container recreate. CI builds the real image and starts the stack on every change (`deploy` job). Not yet verified: a real public certificate, Nginx Proxy Manager specifically, SMTP delivery, and OIDC against a real identity provider.
