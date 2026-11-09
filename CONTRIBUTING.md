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
  apps/
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
```

Work from the current default branch in a scoped feature branch. In the PR, identify the milestone, describe the change, and provide verification evidence. Include responsive screenshots for UI changes. Record provenance for new assets. Keep generated output and local environment files outside commits.

See the [marketing README](apps/marketing/README.md) for commands and [verification](docs/VERIFICATION.md) for release checks.

The API, web application, versioned API contract and self-hosting setup belong in this repository when their phases restart. Native Android and iOS each have a separate future repository.
