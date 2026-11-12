// Process entry point: `node src/server.ts`. Reads configuration from the environment.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { migrate } from './migrate.ts';
import { createApp, type Route } from './http/app.ts';
import { configFromEnv } from './auth/config.ts';
import { authenticator } from './auth/sessions.ts';
import { authRoutes } from './auth/routes.ts';
import { createSmtpMailer } from './auth/mailer.ts';
import { createOidcProvider } from './auth/oidc.ts';
import type { AuthContext } from './auth/context.ts';
import { API_VERSION } from './version.ts';

const env = process.env;
const pool = new pg.Pool({ connectionString: env['DATABASE_URL'] });
pool.on('error', (e) => console.error('idle database client error', e));
const smtp = env['DRIVELOOM_SMTP_URL'] && env['DRIVELOOM_SMTP_FROM'] ? createSmtpMailer(env['DRIVELOOM_SMTP_URL'], env['DRIVELOOM_SMTP_FROM']) : null;
const config = configFromEnv(env, !!smtp);
const c = await pool.connect();
try { await migrate(c); } finally { c.release(); }

const ctx: AuthContext = { db: pool, config, mailer: smtp, oidc: config.oidc ? createOidcProvider(config.oidc) : null, now: () => new Date() };
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const system: Route[] = [
  { method: 'GET', path: '/v1/health', auth: 'none', handler: async () => { await pool.query('SELECT 1'); return { status: 200, body: { status: 'ok', database: 'ok' } }; } },
  { method: 'GET', path: '/v1/version', auth: 'none', handler: async () => {
    const { rows } = await pool.query<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations');
    return { status: 200, body: { server: pkg.version, api: API_VERSION, schema: rows[0]!.v ?? 0 } };
  } },
];
const routes: Route[] = [...system, ...authRoutes(ctx)];
const app = createApp({ routes, authenticator: authenticator(ctx), publicOrigin: config.publicOrigin, ipTrust: config.ipTrust });
const port = Number(env['PORT'] ?? 8080);
createServer((req, res) => void app(req, res)).listen(port, env['HOST'] ?? '127.0.0.1', () => console.log(`driveloom api listening on ${port}`));
