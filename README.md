# DriveLoom

DriveLoom is an open-source, self-hosted fuel tracker for recording fill-ups, understanding fuel economy, and sharing vehicles with other users on an instance.

- `apps/api`: the server (Node 22, TypeScript, PostgreSQL 16).
- `apps/web`: the web client.
- `apps/marketing`: the project website, published to GitHub Pages from `main`.
- `deploy/`: Docker Compose and reverse-proxy examples (`deploy/compose.yml`, `deploy/.env.example`).

## Run

Copy `deploy/.env.example` to `deploy/.env`, fill it in, then:

```sh
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
```

On Windows, `dev-up.cmd` wraps the same steps in a menu.

Work happens on `dev`; merging `dev` into `main` publishes the image to `ghcr.io/aulteran/driveloom`.

## License

[AGPL-3.0-only](LICENSE). Bundled third-party assets keep their own terms; see [apps/marketing/ASSET-PROVENANCE.md](apps/marketing/ASSET-PROVENANCE.md).
