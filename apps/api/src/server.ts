// Process entry point: `node src/server.ts`. Reads configuration from the
// environment (docs/DEPLOYMENT.md), runs migrations, then serves the API under
// /v1 and the web client everywhere else on one origin.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from './migrate.ts';
import { configFromEnv } from './auth/config.ts';
import { createSmtpMailer } from './auth/mailer.ts';
import { createOidcProvider } from './auth/oidc.ts';
import type { AuthContext } from './auth/context.ts';
import { createApplication, SERVER_VERSION } from './application.ts';

const env = process.env;
if (!env['DATABASE_URL']) { console.error('DATABASE_URL is required'); process.exit(2); }
const pool = new pg.Pool({ connectionString: env['DATABASE_URL'], max: Number(env['DATABASE_POOL_SIZE'] ?? 10) });
pool.on('error', (e) => console.error('idle database client error', e.message));
const smtp = env['DRIVELOOM_SMTP_URL'] && env['DRIVELOOM_SMTP_FROM'] ? createSmtpMailer(env['DRIVELOOM_SMTP_URL'], env['DRIVELOOM_SMTP_FROM']) : null;
const config = configFromEnv(env, !!smtp);

// The database may still be starting (compose): retry the first connection for a while.
let c: pg.PoolClient | undefined;
for (let attempt = 1; !c; attempt++) {
  try { c = await pool.connect(); } catch (e) {
    if (attempt >= 30) throw e;
    console.log(`waiting for the database (${(e as Error).message})`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
try {
  const applied = await migrate(c);
  if (applied.length) console.log(`applied migrations: ${applied.join(', ')}`);
  await c.query('INSERT INTO instance_meta (instance_id) SELECT gen_random_uuid() WHERE NOT EXISTS (SELECT 1 FROM instance_meta)');
  const users = (await c.query('SELECT 1 FROM users LIMIT 1')).rowCount;
  if (!users && !config.setupToken) console.warn('WARNING: no account exists yet. The first registration becomes the administrator. Register now, or set DRIVELOOM_SETUP_TOKEN if this instance is reachable by others.');
} finally { c.release(); }

const ctx: AuthContext = { db: pool, config, mailer: smtp, oidc: config.oidc ? createOidcProvider(config.oidc) : null, now: () => new Date() };
const defaultWeb = fileURLToPath(new URL('../../web/', import.meta.url));
const webDir = env['DRIVELOOM_WEB_DIR'] ?? (existsSync(defaultWeb) ? defaultWeb : null);
const app = createApplication(ctx, { webDir });
const server = createServer((req, res) => void app(req, res));
server.requestTimeout = 60_000;
server.headersTimeout = 20_000;
const port = Number(env['PORT'] ?? 8080), host = env['HOST'] ?? '127.0.0.1';
server.listen(port, host, () => console.log(`driveloom ${SERVER_VERSION} listening on http://${host}:${port} (public origin ${config.publicOrigin}${webDir ? ', web client on' : ', API only'})`));

const stop = (signal: string) => {
  console.log(`${signal}: shutting down`);
  server.close(() => void pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
