import { Pool } from 'pg';
import { migrateSync } from '../src/postgres.js';

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://example:example@127.0.0.1:55449/example',
});
try {
  await migrateSync(pool);
  await pool.query(
    'CREATE TABLE IF NOT EXISTS notes(owner_id text NOT NULL, key text NOT NULL, value text NOT NULL, version bigint NOT NULL DEFAULT 1, PRIMARY KEY(owner_id,key))',
  );
} finally {
  await pool.end();
}
