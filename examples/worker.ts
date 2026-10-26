import { Pool } from "pg";
import { createPostgresSync, SyncError } from "../src/postgres.js";

type Command = { key: string; value: string };
type Bindings = { DATABASE_URL: string; DEMO_PRINCIPAL: string; BUILD_ID?: string };

function property(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") throw new SyncError("Invalid object.", 400);
  return Reflect.get(value, key);
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new SyncError("Expected text.", 400);
  return value;
}
function command(value: unknown) {
  const name = property(value, "name");
  const args = property(value, "args");
  const sequence = property(value, "sequence");
  if (name !== "setNote" || typeof sequence !== "number")
    throw new SyncError("Invalid command.", 400);
  return {
    id: text(property(value, "id")),
    sequence,
    name,
    args,
    command: { key: text(property(args, "key")), value: text(property(args, "value")) },
  };
}

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);
    if (!["localhost", "127.0.0.1"].includes(url.hostname))
      return new Response("Local example only.", { status: 403 });
    if (url.pathname === "/health")
      return Response.json({
        status: "ok",
        app: "isocache-example",
        environment: "local",
        protocol: 2,
        build: env.BUILD_ID ?? "example",
      });
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 3,
      connectionTimeoutMillis: 2000,
    });
    const engine = createPostgresSync<Command, Command>({
      pool,
      application: {
        async apply(tx, context, command) {
          await tx.query(
            "INSERT INTO notes(owner_id,key,value) VALUES($1,$2,$3) ON CONFLICT(owner_id,key) DO UPDATE SET value=$3, version=notes.version+1",
            [context.principalID, command.key, command.value],
          );
          return { status: "accepted" };
        },
        async readView(tx, context) {
          const result = await tx.query(
            "SELECT key,value,version::text FROM notes WHERE owner_id=$1 ORDER BY key",
            [context.principalID],
          );
          return {
            rows: result.rows.map((raw: unknown) => {
              const key = text(property(raw, "key"));
              return {
                key,
                version: text(property(raw, "version")),
                value: { key, value: text(property(raw, "value")) },
              };
            }),
          };
        },
      },
    });
    try {
      if (request.method !== "POST") return new Response("Not found.", { status: 404 });
      const body: unknown = await request.json();
      if (property(body, "version") !== 2) throw new SyncError("Invalid envelope.", 400);
      const clientID = text(property(body, "clientID"));
      if (url.pathname === "/push") {
        const values = property(body, "operations");
        if (!Array.isArray(values)) throw new SyncError("Invalid operations.", 400);
        const operations = values.map((raw: unknown) => command(raw));
        await engine.push({
          principalID: env.DEMO_PRINCIPAL,
          request: { version: 2, clientID, operations },
        });
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/pull") {
        const cookie = property(body, "cookie");
        if (cookie !== null && typeof cookie !== "string")
          throw new SyncError("Invalid cookie.", 400);
        return Response.json(
          await engine.pull({
            principalID: env.DEMO_PRINCIPAL,
            request: { version: 2, clientID, cookie },
          }),
        );
      }
      return new Response("Not found.", { status: 404 });
    } catch (error) {
      if (error instanceof SyncError)
        return Response.json({ error: error.message }, { status: error.status });
      throw error;
    } finally {
      await pool.end();
    }
  },
};
