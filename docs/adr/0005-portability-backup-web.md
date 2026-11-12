# ADR 0005: Portability, images, backup, web client and deployment (milestones 1.6, 2.1, 2.2)

Status: decided during the autonomous build of 2026-11-12, for owner review.

## Portability

- **Two vehicle formats.** CSV for spreadsheets and other trackers, versioned JSON (`driveloom.vehicle` v1) for moving a vehicle between instances. Both carry entered values and units, not normalised ones, so nothing is lost and a re-import reproduces the original entries.
- **No identities in exports.** No ids, members, users or images. A file lands under the importer's permissions on any instance, and an export shared by mistake reveals only that vehicle's purchases.
- **Preview by default.** `dryRun` is true unless the caller sends `false`. A dry run executes the same statements and rolls back, so the preview cannot disagree with the commit.
- **All-or-nothing commit, duplicates skipped.** Same instant and odometer reading as an existing purchase counts as a duplicate. Re-importing a file is therefore harmless.
- **Spreadsheet formula neutralisation** on CSV export, reversed on import, so the round trip is exact.

## Images

- **In PostgreSQL, not on disk.** One photo per vehicle, at most 5 MiB, in `bytea`. This keeps authorization, transactions and the backup in one place and needs no second volume. Revisit if photo galleries or larger files are ever wanted.
- **Type from bytes.** JPEG, PNG and WebP only, decided by the leading bytes. Served with a sandboxing CSP and `nosniff`. No re-encoding, so EXIF metadata (including GPS location) is kept as uploaded; see the owner list.

## Instance backup

- **Own format rather than `pg_dump`.** The image does not need PostgreSQL client tools of a matching major version, the archive carries the schema version and a checksum, restore checks the whole file before writing, and an older archive migrates forward with this build's own migrations. `pg_dump` remains a valid extra for operators who prefer it.
- **Sessions and short-lived codes are excluded.** A restored instance should not accept sessions from the original.
- **One transaction for restore,** including `--replace`, so a failure leaves the target as it was.

## Administration

- **Invitations** are the way in when registration is closed (the default). Tokens are shown once and stored hashed. An invitation can be bound to an email.
- **Admins manage accounts, not data.** Disable, enable, change role, invite, read the audit log. No route shows an admin anyone's vehicles. Password reset for a locked-out person is a server command, so a stolen admin session cannot take over accounts.

## Web client (2.1)

- **No framework, no build step.** Vanilla ES modules, about 1,500 lines. Nothing to compile, no supply chain beyond the browser, and a strict CSP (`script-src 'self'`, no inline style) is easy to keep. Revisit if the client grows substantially.
- **Hash routing.** Keeps the server's fallback trivial and makes deep links work behind any proxy.
- **Text nodes only.** All DOM is built from text nodes and properties; `innerHTML` is never used, so stored text cannot become markup.
- **No browser storage.** The session is the HttpOnly cookie; the CSRF token lives in memory.
- **Design.** One small token-based stylesheet with light and dark themes from the system setting, responsive down to 360 px, visible focus, reduced motion respected. Checked with axe (WCAG 2.2 AA tags) in both themes in CI.
- **PWA without a service worker.** Installable from the manifest. Offline reading and offline writes are deferred: they need conflict rules for fill-ups recorded on two devices, which the roadmap says to review first.

## Deployment (2.2)

- **One image, one process, one origin.** The API and client together, so cookies, CSRF and passkeys need no cross-origin setup. Node runs the TypeScript sources directly; the image has only production dependencies.
- **Compose with an internal network.** PostgreSQL is not published; the app is published on the host's loopback for a local reverse proxy.
- **Closed registration and a setup token** are the defaults in the example settings.

## Not done

- Offline support (service worker, local queue).
- Image resizing and metadata stripping.
- Scheduled backups inside the app (operators use cron with the CLI).
