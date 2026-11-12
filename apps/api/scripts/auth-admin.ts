// Operator recovery without email: `node scripts/auth-admin.ts reset-password <email>`
// Reads the new password from DRIVELOOM_NEW_PASSWORD. Audited; revokes all sessions.
import pg from 'pg';
import { adminResetPassword } from '../src/auth/accounts.ts';
import { defaultConfig } from '../src/auth/config.ts';

const [cmd, email] = process.argv.slice(2);
const pw = process.env['DRIVELOOM_NEW_PASSWORD'];
if (cmd !== 'reset-password' || !email || !pw) {
  console.error('usage: DRIVELOOM_NEW_PASSWORD=... node scripts/auth-admin.ts reset-password <email>');
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
const config = defaultConfig({ publicOrigin: 'http://localhost', secretKey: Buffer.alloc(32) });
await adminResetPassword({ db: pool, config, mailer: null, oidc: null, now: () => new Date() }, email, pw);
console.log('password reset; all sessions revoked');
await pool.end();
