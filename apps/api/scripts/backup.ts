// Instance backup and restore for operators. Reads DATABASE_URL.
//   node scripts/backup.ts create <file>
//   node scripts/backup.ts verify <file>
//   node scripts/backup.ts restore <file> [--replace]
// See docs/DEPLOYMENT.md before using restore --replace.
import pg from 'pg';
import { BackupError, createBackup, restoreBackup, verifyBackup } from '../src/backup.ts';

const [cmd, file, ...flags] = process.argv.slice(2);
const usage = () => { console.error('usage: node scripts/backup.ts create|verify|restore <file> [--replace]'); process.exit(2); };
if (!cmd || !file || !['create', 'verify', 'restore'].includes(cmd) || flags.some((f) => f !== '--replace')) usage();
const describe = (i: { schemaVersion: number; createdAt: string; tables: Record<string, number> }) =>
  `schema ${i.schemaVersion}, created ${i.createdAt}, ${Object.values(i.tables).reduce((a, b) => a + b, 0)} rows in ${Object.keys(i.tables).length} tables`;

try {
  if (cmd === 'verify') {
    console.log(`ok: ${describe(await verifyBackup(file!))}`);
  } else {
    if (!process.env['DATABASE_URL']) { console.error('DATABASE_URL is required'); process.exit(2); }
    if (cmd === 'create') {
      const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
      try { console.log(`backup written: ${describe(await createBackup(pool, file!))}`); } finally { await pool.end(); }
    } else {
      const client = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
      await client.connect();
      try { console.log(`restored: ${describe(await restoreBackup(client, file!, { replace: flags.includes('--replace') }))}`); } finally { await client.end(); }
    }
  }
} catch (e) {
  if (e instanceof BackupError) { console.error(`error (${e.code}): ${e.message}`); process.exit(1); }
  throw e;
}
