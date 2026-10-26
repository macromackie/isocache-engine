import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { Pool } from "pg";

const exec = promisify(execFile);

export async function disposablePostgres({
  owner,
  timeoutMs = 30_000,
}: {
  owner: string;
  timeoutMs?: number;
}) {
  const name = `isocache-test-${randomUUID()}`;
  const password = randomUUID();
  let pool: Pool | undefined;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    const failures: unknown[] = [];
    try {
      await pool?.end();
    } catch (error) {
      failures.push(error);
    }
    pool = undefined;
    try {
      await exec("docker", ["rm", "-f", name], { timeout: 10_000 });
      stopped = true;
    } catch (error) {
      const missingExecutable =
        error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
      const missingContainer =
        error !== null &&
        typeof error === "object" &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("No such container");
      if (missingExecutable || missingContainer) stopped = true;
      else failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "Disposable Postgres cleanup failed.");
  };
  try {
    await exec(
      "docker",
      [
        "run",
        "--rm",
        "--detach",
        "--name",
        name,
        "--cpus",
        "1",
        "--memory",
        "256m",
        "--label",
        `isocache.owner=${owner}`,
        "--label",
        `isocache.review-at=${new Date(Date.now() + 600_000).toISOString()}`,
        "--publish",
        "127.0.0.1::5432",
        "--env",
        `POSTGRES_PASSWORD=${password}`,
        "--env",
        "POSTGRES_DB=isocache_test",
        "postgres:17-alpine",
      ],
      { timeout: timeoutMs },
    );
    const { stdout } = await exec("docker", ["port", name, "5432/tcp"], { timeout: 5_000 });
    const port = Number(stdout.trim().split(":").at(-1));
    const connectionString = `postgres://postgres:${password}@127.0.0.1:${port}/isocache_test`;
    pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 1000 });
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        await pool.query("SELECT 1");
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await setTimeout(100);
      }
    }
    return { pool, connectionString, containerName: name, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
