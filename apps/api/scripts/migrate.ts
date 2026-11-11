import pg from 'pg';
import { migrate } from '../src/migrate.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(2); }
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const applied = await migrate(client);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
} finally {
  await client.end();
}
