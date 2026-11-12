# Repository and contributions

```text
/
  README.md
  CLAUDE.md
  CONTRIBUTING.md
  LICENSE
  docs/
    PRODUCT.md
    ARCHITECTURE.md
    ROADMAP.md
    VERIFICATION.md
    CONTRACTS.md
    DEPLOYMENT.md
    adr/
  Dockerfile
  deploy/
    compose.yml
    compose.dev.yml
    .env.example
    proxy/
  apps/
    api/
      openapi/
      migrations/
      scripts/
      src/
      tests/
    web/
      index.html
      styles.css
      js/
    marketing/
      README.md
      ASSET-PROVENANCE.md
      site.config.json
      package.json
      scripts/
      src/
      tests/
  .github/
    workflows/
      marketing.yml
      api.yml
```

Work from the current default branch in a scoped feature branch. In the PR, identify the milestone, describe the change, and provide verification evidence. Include responsive screenshots for UI changes. Record provenance for new assets. Keep generated output and local environment files outside commits.

See the [marketing README](apps/marketing/README.md) for commands and [verification](docs/VERIFICATION.md) for release checks.

For the platform, from `apps/api` with a PostgreSQL in `DATABASE_URL` (`deploy/compose.dev.yml` starts one): `npm ci`, `npm run check` (types, OpenAPI, web modules), `npm test`, and `npm run test:browser` (needs a Playwright Chromium: `npx playwright install chromium`). The API, web client, versioned API contract and self-hosting setup live in this repository. Native Android and iOS each have a separate future repository.
