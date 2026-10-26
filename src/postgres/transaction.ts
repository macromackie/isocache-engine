import type { Pool, PoolClient } from "pg";

export class SyncError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

function retryable(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "40001" || error.code === "40P01";
}

export async function transaction<Value>(
  pool: Pool,
  run: (client: PoolClient) => Promise<Value>,
  isolation: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE" = "REPEATABLE READ",
): Promise<Value> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    let discard = false;
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
      if (!discard && attempt < 3 && retryable(error)) continue;
      throw error;
    } finally {
      client.release(discard);
    }
  }
}
