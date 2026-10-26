import type { Pool, PoolClient } from 'pg';

export class SyncError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

export async function transaction<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
  isolation: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' = 'REPEATABLE READ',
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      const code = (error as { code?: string }).code;
      if (attempt < 3 && (code === '40001' || code === '40P01')) continue;
      throw error;
    } finally {
      client.release();
    }
  }
}
