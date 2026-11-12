# DriveLoom

DriveLoom is an open-source, self-hosted fuel tracker for recording fill-ups, understanding fuel economy, and sharing vehicles with other users on an instance.

- `apps/api`: the server (Node 22, TypeScript, PostgreSQL 16). It serves the API under `/v1` and the web client.
- `apps/web`: the web client, an installable web app with no build step.
- `apps/marketing`: the coming-soon website, live on GitHub Pages.
- `deploy/`: Docker Compose and reverse-proxy examples. Start with the [self-hosting guide](docs/DEPLOYMENT.md).

The platform was built on 2026-11-12 and is in review: it has not had a security review or a release yet. DriveLoom is the working name.

- [Product and scope](docs/PRODUCT.md)
- [Architecture and dependencies](docs/ARCHITECTURE.md)
- [Milestones and acceptance criteria](docs/ROADMAP.md)
- [Verification and release checklist](docs/VERIFICATION.md)
- [Contracts](docs/CONTRACTS.md) and [decision records](docs/adr/)
- [Self-hosting](docs/DEPLOYMENT.md)
- [Repository layout and contributions](CONTRIBUTING.md)

The platform is licensed under [AGPL-3.0-only](LICENSE). Bundled third-party assets retain their applicable terms. See the [marketing asset register](apps/marketing/ASSET-PROVENANCE.md).
