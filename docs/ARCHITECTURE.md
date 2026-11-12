# Architecture and dependency plan

## Phase 0

```text
apps/marketing sources → reproducible static build → Pages artifact → GitHub Pages
```

The site uses semantic HTML and CSS with dependency-free build scripts on Node 22. Use the runtime in the marketing .nvmrc for local preview, Claude cloud and CI. No production database, backend, auth or environment secrets are required. Prefer local fonts/assets or system fonts and keep third-party requests out of the launch baseline.

**Deployment contract.** PR checks build and test with read-only repository permissions. The Pages workflow validates PRs and builds the default branch. The release jobs upload only `apps/marketing/dist` (or the documented equivalent), then deploys in the `github-pages` environment. The workflow uses GitHub's Pages upload and deploy actions. Build permissions are read-only. The deployment job receives `pages: write` and `id-token: write`. Restrict the deployment environment to the default branch and serialize deployments. By owner decision (2026-11-09), pushes to the default branch that touch the marketing site deploy automatically with no required reviewer. PRs run all checks but never deploy. Never deploy from a PR or expose Pages write permissions to PR code. Keep docs, private files and test fixtures out of the artifact.

**URL contract.** Test the project-site prefix `/<repo>/` for assets, routes, links and metadata. Default launch can use the owner-approved Pages URL. An owned custom domain is optional and introduces DNS verification, HTTPS and canonical URL changes. Use the approved final URL for the canonical link, sitemap and share cards. Private review artifacts are the initial verification target.

[GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

## Platform

As built on 2026-11-12: one Node 22 process (TypeScript run directly) serving the `/v1` API and the `apps/web` client on one origin, PostgreSQL 16 for all data including images, Docker Compose for deployment. Module contracts are in [contracts](CONTRACTS.md), decisions in [ADRs 0001 to 0005](adr/), operations in [deployment](DEPLOYMENT.md). The text below is the original plan the build followed.

Milestone 1.1 foundations (OpenAPI skeleton, identifiers, migrations, test infrastructure) are documented in [contracts](CONTRACTS.md) and [ADR 0001](adr/0001-platform-foundations.md) as proposed defaults.

**Recommended architecture.** A modular backend with a versioned REST/OpenAPI contract, PostgreSQL and private image storage. Serve the web/PWA over the same public origin where practical. Deploy the API/web and database via Docker Compose on an internal network with persistent volumes. Document the instance public URL, stable WebAuthn origin and relying party ID, trusted proxy ranges, secure cookies and validated forwarding. The main platform repository holds API, web and deployment. Future native clients consume the published contract and use a secure native authentication flow selected before that phase.

| Boundary | Data and invariants |
| --- | --- |
| Accounts and authentication | User, credentials, linked OIDC identities, sessions, recovery artifacts and audit events. Use established password, WebAuthn, TOTP, OIDC and SMTP libraries. Keep challenge lifetime, replay prevention, reauthentication and rate limits explicit. Bind OIDC identities to issuer and subject, use authorization code with PKCE, and require verified linking. Protect browser sessions with secure cookies and CSRF controls. Design token lifecycle separately for native clients. |
| Vehicles and sharing | Owner, vehicle members, role grants and images. Proposed invariant is one owner per active vehicle. Apply authorization server-side for every read, mutation and export. Audit recovery without granting routine vehicle-data visibility to instance administrators. |
| Fuel and odometer | Preserve input quantities and units, store decimal normalized values, define an authoritative chronological order and recalculate affected intervals after edits, inserts or deletions. In the proposed full-to-full method, include intervening partial purchases and closing fuel, exclude the starting fill, and report ambiguous or incomplete intervals as unavailable. Aggregate distance and volume before calculating economy. |
| Units and money | Convert at input boundaries and round at display. Specify US versus Imperial gallons and US MPG, Imperial MPG, L/100 km and km/L. Store ISO currency identifiers, source amount and any reporting amount and rate. Keep changes in reporting currency as a future explicit migration policy. |
| Friends and analytics | Accepted relationship plus vehicle opt-in grants only scoped aggregates. Apply grants at query time, normalize physical units to the viewer and handle revoked access in caches. Distinguish efficiency from spending. |
| Import, export and restore | Versioned export schema with validation and preview. Idempotency or duplicate detection and a transaction for commit. Import vehicle data into destination permissions. Instance archives use schema/version metadata and integrity checks. Verify restorability in isolation, keep backups private, and document CLI recovery and replacement safeguards. |

**Dependency decisions at restart.** Select server/web frameworks, language, supported PostgreSQL and container versions, migrations, upload storage, auth libraries, OpenAPI validation, decimal and CSV libraries, and test tooling in reviewed architecture records. Use PostgreSQL integration tests for transactional invariants. Review dependency compatibility with AGPL-3.0-only. Optional SMTP/OIDC services are instance configuration. No exchange-rate API is assumed. Exact SDKs and mobile platforms are deferred.
