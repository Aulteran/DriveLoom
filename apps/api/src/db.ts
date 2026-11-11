// Minimal database helpers shared by modules. Modules take a `pg.Pool`.
import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

/** Run `fn` in one transaction; roll back on any throw. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const out = await fn(tx);
    await tx.query('COMMIT');
    return out;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    tx.release();
  }
}
