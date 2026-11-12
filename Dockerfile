# DriveLoom: the API and the web client in one image. Node runs the
# TypeScript sources directly (type stripping), so there is no build stage.
FROM node:22-bookworm-slim

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app/apps/api

COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY apps/api/src ./src
COPY apps/api/migrations ./migrations
COPY apps/api/scripts/migrate.ts apps/api/scripts/backup.ts apps/api/scripts/auth-admin.ts ./scripts/
COPY apps/web /app/apps/web

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/v1/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/server.ts"]
