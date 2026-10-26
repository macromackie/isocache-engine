import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  createPostgresSync,
  migrateSync,
  pruneViews,
  SyncError,
  transaction,
} from "../src/postgres.js";
import type { ApplicationSync, DecodedOperation } from "../src/postgres.js";
import type { Outcome, VersionedRow } from "../src/protocol.js";
import { disposablePostgres } from "../src/testing.js";
import fixture from "./fixtures/v2.json" with { type: "json" };

type Command = { key: string; value: string; result?: "reject" | "notice" | "fail" };
type Entity = { key: string; value: string };

function rowText(raw: unknown, name: string): string {
  assert.ok(raw !== null && typeof raw === "object");
  const value: unknown = Reflect.get(raw, name);
  assert.ok(typeof value === "string");
  return value;
}
function itemRow(raw: unknown) {
  return {
    key: rowText(raw, "key"),
    value: rowText(raw, "value"),
    version: rowText(raw, "version"),
  };
}

await test("Postgres protocol durability and account isolation", { timeout: 60_000 }, async (t) => {
  const database = await disposablePostgres({ owner: "isocache-engine-tests" });
  t.after(() => database.stop());
  const { pool } = database;
  await migrateSync(pool);
  await migrateSync(pool);
  await pool.query(
    "CREATE TABLE items(owner_id text NOT NULL, key text NOT NULL, value text NOT NULL, version bigint NOT NULL DEFAULT 1, PRIMARY KEY(owner_id,key))",
  );
  let failure = true;
  const application: ApplicationSync<Command, Entity> = {
    async apply(tx, context, command): Promise<Outcome> {
      await tx.query(
        "INSERT INTO items(owner_id,key,value) VALUES($1,$2,$3) ON CONFLICT(owner_id,key) DO UPDATE SET value=$3, version=items.version+1",
        [context.principalID, command.key, command.value],
      );
      if (command.result === "fail" && failure) throw new Error("Unavailable database dependency");
      if (command.result === "reject")
        return { status: "rejected", code: "conflict", message: "Edit conflicts." };
      if (command.result === "notice")
        return { status: "appliedWithNotice", code: "adjusted", message: "Saved with a notice." };
      return { status: "accepted", recipients: [context.principalID] };
    },
    async readView(tx, context) {
      const result = await tx.query(
        "SELECT key,value,version::text FROM items WHERE owner_id=$1 ORDER BY key",
        [context.principalID],
      );
      return {
        rows: result.rows.map((raw: unknown) => {
          const { key, value, version } = itemRow(raw);
          return { key, version, value: { key, value } };
        }),
      };
    },
  };
  const engine = createPostgresSync({ pool, application });
  const operation = (sequence: number, command: Command): DecodedOperation<Command> => ({
    id: randomUUID(),
    sequence,
    name: "set",
    args: command,
    command,
  });
  const push = (principalID: string, clientID: string, operations: DecodedOperation<Command>[]) =>
    engine.push({ principalID, request: { version: 2, clientID, operations } });
  const pull = (principalID: string, clientID: string, cookie: string | null = null) =>
    engine.pull({ principalID, request: { version: 2, clientID, cookie } });
  const conflict = (error: unknown) => error instanceof SyncError && error.status === 409;

  await t.test(
    "duplicates are immutable and a committed prefix survives an infrastructure failure",
    async () => {
      const client = randomUUID();
      const first = operation(1, { key: "a", value: "first" });
      const second = operation(2, { key: "b", value: "second", result: "fail" });
      await assert.rejects(push("prefix", client, [first, second]), /Unavailable/);
      const prefix = await pull("prefix", client);
      assert.equal(prefix.lastSequence, 1);
      assert.deepEqual(
        prefix.put.map((row) => row.value),
        [{ key: "a", value: "first" }],
      );
      failure = false;
      await push("prefix", client, [first, second]);
      await push("prefix", client, [first, second]);
      const final = await pull("prefix", client, prefix.cookie);
      assert.equal(final.lastSequence, 2);
      assert.deepEqual(
        final.put.map((row) => row.value),
        [{ key: "b", value: "second" }],
      );
      await assert.rejects(
        push("prefix", client, [operation(4, { key: "gap", value: "bad" })]),
        conflict,
      );
      await assert.rejects(
        push("prefix", client, [
          {
            ...first,
            args: { key: "a", value: "changed" },
            command: { key: "a", value: "changed" },
          },
        ]),
        conflict,
      );
      await assert.rejects(push("prefix", client, [operation(1, first.command)]), conflict);
      await push("prefix", client, [{ ...first, command: { ...first.command, result: "fail" } }]);
      await assert.rejects(
        push("prefix", client, [{ ...first, name: "differentMutator" }]),
        conflict,
      );
    },
  );

  await t.test(
    "terminal rejections roll back application writes and preserve UUID binding",
    async () => {
      const client = randomUUID();
      const rejected = operation(1, { key: "bad", value: "must not appear", result: "reject" });
      const notice = operation(2, { key: "good", value: "saved", result: "notice" });
      await push("outcomes", client, [rejected, notice]);
      const update = await pull("outcomes", client);
      assert.equal(update.lastSequence, 2);
      assert.deepEqual(
        update.put.map((row) => row.key),
        ["good"],
      );
      assert.deepEqual(
        update.rejections.map(({ id, code, status }) => ({ id, code, status })),
        [
          { id: rejected.id, code: "conflict", status: "rejected" },
          { id: notice.id, code: "adjusted", status: "appliedWithNotice" },
        ],
      );
      assert.equal((await pull("outcomes", client, update.cookie)).rejections.length, 0);
      assert.equal((await pull("outcomes", client)).rejections.length, 2);
      await assert.rejects(
        push("outcomes", randomUUID(), [{ ...rejected, sequence: 1 }]),
        conflict,
      );
      await assert.rejects(push("outcomes", client, [{ ...rejected, sequence: 3 }]), conflict);
    },
  );

  await t.test("UUID reuse racing across clients produces one terminal operation", async () => {
    const shared = operation(1, { key: "race", value: "once" });
    const results = await Promise.allSettled([
      push("race", randomUUID(), [shared]),
      push("race", randomUUID(), [{ ...shared, id: String(shared.id).toUpperCase() }]),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const failed = results.find((result) => result.status === "rejected");
    assert.ok(failed?.status === "rejected" && conflict(failed.reason));
    const row = await pool.query("SELECT version FROM items WHERE owner_id=$1 AND key=$2", [
      "race",
      "race",
    ]);
    assert.equal(Number(rowText(row.rows[0], "version")), 1);
  });

  await t.test(
    "authorized removals, CVR loss, receipt replay, and cross-account client isolation",
    async () => {
      const client = randomUUID();
      await push("owner", client, [operation(1, { key: "__proto__", value: "safe" })]);
      const first = await pull("owner", client);
      assert.deepEqual(
        first.put.map((row) => row.key),
        ["__proto__"],
      );
      await pool.query("DELETE FROM items WHERE owner_id=$1", ["owner"]);
      const removal = await pull("owner", client, first.cookie);
      assert.deepEqual(removal.del, ["__proto__"]);
      assert.ok(removal.order > first.order);
      await assert.rejects(
        pull("intruder", client),
        (error) => error instanceof SyncError && error.status === 403,
      );
      const other = await pull("intruder", randomUUID(), removal.cookie);
      assert.equal(other.clear, true);
      assert.equal(other.put.length, 0);
      await pool.query("UPDATE isocache.client_views SET created_at=now()-interval '8 days'");
      assert.equal(await pruneViews(pool, { limit: 1 }), 1);
      const reset = await pull("owner", client, removal.cookie);
      assert.equal(reset.clear, true);
      assert.equal(reset.lastSequence, 1);
      const count = await pool.query(
        "SELECT count(*) FROM isocache.operation_receipts WHERE client_id=$1",
        [client],
      );
      assert.equal(rowText(count.rows[0], "count"), "1");
    },
  );

  await t.test(
    "pull projection and metadata come from a consistent snapshot during another write",
    async () => {
      const writer = randomUUID();
      await push("snapshot", writer, [
        operation(1, { key: "one", value: "old" }),
        operation(2, { key: "two", value: "old" }),
      ]);
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const snapshotEngine = createPostgresSync({
        pool,
        application: {
          ...application,
          async readView(tx, context) {
            const first = await tx.query(
              "SELECT key,value,version::text FROM items WHERE owner_id=$1 AND key=$2",
              [context.principalID, "one"],
            );
            entered.resolve();
            await resume.promise;
            const second = await tx.query(
              "SELECT key,value,version::text FROM items WHERE owner_id=$1 AND key=$2",
              [context.principalID, "two"],
            );
            const rows: VersionedRow<Entity>[] = [
              ...first.rows.map((raw: unknown) => itemRow(raw)),
              ...second.rows.map((raw: unknown) => itemRow(raw)),
            ].map(({ key, value, version }) => {
              return { key, version, value: { key, value } };
            });
            return { rows };
          },
        },
      });
      const pending = snapshotEngine.pull({
        principalID: "snapshot",
        request: { version: 2, clientID: randomUUID(), cookie: null },
      });
      await entered.promise;
      try {
        await push("snapshot", writer, [operation(3, { key: "two", value: "new" })]);
      } finally {
        resume.resolve();
      }
      assert.deepEqual(
        (await pending).put.map((row) => row.value.value),
        ["old", "old"],
      );
    },
  );

  await t.test(
    "legacy metadata keeps v1 cookies and v2 acknowledgements without a migration",
    async () => {
      await pool.query(`
      CREATE TABLE sync_clients (id uuid PRIMARY KEY, owner_id text NOT NULL, last_sequence bigint NOT NULL DEFAULT 0, protocol_version integer NOT NULL DEFAULT 1, last_seen_at timestamptz);
      CREATE TABLE operation_receipts (client_id uuid REFERENCES sync_clients(id), sequence bigint, error text, mutator text, processed_at timestamptz DEFAULT clock_timestamp(), PRIMARY KEY(client_id,sequence));
      CREATE SEQUENCE client_view_order;
      CREATE TABLE client_views (id uuid PRIMARY KEY, client_id uuid REFERENCES sync_clients(id), versions jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), cookie_order bigint NOT NULL DEFAULT nextval('client_view_order'), last_sequence bigint NOT NULL DEFAULT 0);
    `);
      const legacy = createPostgresSync({
        pool,
        application,
        metadata: {
          tables: {
            clients: "sync_clients",
            receipts: "operation_receipts",
            views: "client_views",
          },
          receiptIdentity: "sequence",
        },
      });
      const clientID = randomUUID();
      await legacy.push({
        principalID: "legacy",
        request: {
          version: 1,
          clientID,
          operations: [{ sequence: 1, command: { key: "old", value: "kept" } }],
        },
      });
      const first = await legacy.pull({
        principalID: "legacy",
        request: { version: 1, clientID, cookie: null },
      });
      await legacy.push({
        principalID: "legacy",
        request: {
          version: 2,
          clientID,
          operations: [
            { id: randomUUID(), sequence: 1, command: { key: "old", value: "duplicate" } },
            {
              id: randomUUID(),
              sequence: 2,
              command: { key: "rejected", value: "bad", result: "reject" },
            },
          ],
        },
      });
      const v1 = await legacy.pull({
        principalID: "legacy",
        request: { version: 1, clientID, cookie: first.cookie },
      });
      assert.equal(v1.cookie, first.cookie);
      assert.equal(v1.lastSequence, 2);
      assert.deepEqual(v1.rejections, [{ sequence: 2, error: "Edit conflicts." }]);
      const v2 = await legacy.pull({
        principalID: "legacy",
        request: { version: 2, clientID, cookie: v1.cookie },
      });
      assert.notEqual(v2.cookie, v1.cookie);
      assert.deepEqual(v2.rejections, v1.rejections);
      const acknowledged = await legacy.pull({
        principalID: "legacy",
        request: { version: 2, clientID, cookie: v2.cookie },
      });
      assert.equal(acknowledged.rejections.length, 0);
    },
  );

  await t.test("the shared Swift v2 fixture reaches the typed application boundary", async () => {
    type Value = { type: "value"; key: string; value: number };
    const fixtureEngine = createPostgresSync<{ key: string; value: number }, Value>({
      pool,
      application: {
        async apply(tx, context, command) {
          if (context.sequence === 6)
            return { status: "rejected", code: "conflict", message: "The value changed." };
          await tx.query(
            "INSERT INTO items(owner_id,key,value) VALUES($1,$2,$3) ON CONFLICT(owner_id,key) DO UPDATE SET value=$3",
            [context.principalID, command.key, String(command.value)],
          );
          return { status: "accepted" };
        },
        async readView(tx, context) {
          const result = await tx.query("SELECT key,value FROM items WHERE owner_id=$1", [
            context.principalID,
          ]);
          return {
            rows: result.rows.map((raw: unknown) => {
              const key = rowText(raw, "key"),
                value = rowText(raw, "value");
              return {
                key: "value/" + key,
                version: "revision-" + value,
                value: { type: "value" as const, key, value: Number(value) },
              };
            }),
          };
        },
      },
    });
    const wire = fixture.operations.operations[0];
    const rejection = fixture.updates.rejections[0];
    assert.ok(wire && rejection);
    const prefix = Array.from({ length: 6 }, (_, index) => ({
      ...wire,
      id: index === 5 ? rejection.id : randomUUID(),
      sequence: index + 1,
      command: wire.args,
    }));
    await fixtureEngine.push({
      principalID: "wire",
      request: {
        ...fixture.operations,
        version: 2,
        operations: [...prefix, { ...wire, command: wire.args }],
      },
    });
    const response = await fixtureEngine.pull({
      principalID: "wire",
      request: { ...fixture.request, version: 2 },
    });
    const wireResponse: unknown = await Response.json({
      ...response,
      cookie: fixture.updates.cookie,
      order: fixture.updates.order,
    }).json();
    assert.deepEqual(wireResponse, fixture.updates);
  });
  await t.test(
    "a serialization retry repeats only uncommitted work and rollback failure preserves the cause",
    async () => {
      let attempts = 0;
      await transaction(pool, async (tx) => {
        await tx.query("INSERT INTO items(owner_id,key,value) VALUES($1,$2,$3)", [
          "retry",
          "once",
          "saved",
        ]);
        if (++attempts === 1)
          throw Object.assign(new Error("Retry this transaction"), { code: "40001" });
      });
      assert.equal(attempts, 2);
      assert.equal((await pull("retry", randomUUID())).put.length, 1);
      const original = new Error("Application failed after its connection was lost");
      await assert.rejects(
        transaction(pool, async (tx) => {
          tx.on("error", () => {});
          try {
            await tx.query("SELECT pg_terminate_backend(pg_backend_pid())");
          } catch {
            /* The backend closes this connection before replying. */
          }
          throw original;
        }),
        (error) => error === original,
      );
      assert.equal((await pool.query("SELECT 1")).rowCount, 1);
    },
  );

  await t.test(
    "an invalid JavaScript adapter outcome cannot commit data or a sequence",
    async () => {
      const invalid = createPostgresSync<Command, Entity>({
        pool,
        application: {
          ...application,
          // @ts-expect-error JavaScript adapters can return values that bypass the TypeScript contract.
          async apply(tx, context, command): Promise<unknown> {
            await application.apply(tx, context, command);
            return { status: "accepted", message: "not an accepted outcome" };
          },
        },
      });
      const client = randomUUID();
      await assert.rejects(
        invalid.push({
          principalID: "invalid",
          request: {
            version: 2,
            clientID: client,
            operations: [operation(1, { key: "bad", value: "not committed" })],
          },
        }),
        /Accepted application outcomes/,
      );
      const result = await pull("invalid", client);
      assert.equal(result.lastSequence, 0);
      assert.equal(result.put.length, 0);
    },
  );

  await t.test("an adapter sidecar cannot overwrite engine-owned update fields", async () => {
    const isolated = createPostgresSync({
      pool,
      application: {
        ...application,
        async readView(tx, context) {
          return {
            ...(await application.readView(tx, context)),
            lastSequence: 999,
            clear: false,
            cookie: "adapter-cookie",
            order: -1,
            put: [{ key: "injected" }],
          };
        },
      },
    });
    const update = await isolated.pull({
      principalID: "sidecar",
      request: { version: 2, clientID: randomUUID(), cookie: null },
    });
    assert.equal(update.lastSequence, 0);
    assert.equal(update.clear, true);
    assert.notEqual(update.cookie, "adapter-cookie");
    assert.ok(update.order > 0);
    assert.equal(update.put.length, 0);
  });

  await t.test(
    "a populated v0.1 schema gains migration tracking without changing receipts or CVRs",
    async () => {
      await pool.query("DROP SCHEMA isocache CASCADE");
      await pool.query(await readFile(new URL("fixtures/v0.1.sql", import.meta.url), "utf8"));
      const client = randomUUID();
      await push("upgrade", client, [
        operation(1, { key: "kept", value: "saved" }),
        operation(2, { key: "rejected", value: "not saved", result: "reject" }),
        operation(3, { key: "notice", value: "saved with notice", result: "notice" }),
      ]);
      const before = await pull("upgrade", client);
      await migrateSync(pool);
      await migrateSync(pool);
      const after = await pull("upgrade", client, before.cookie);
      assert.equal(after.cookie, before.cookie);
      assert.equal(after.lastSequence, 3);
      assert.equal(after.put.length, 0);
      assert.deepEqual((await pull("upgrade", client)).rejections, before.rejections);
      assert.equal(
        (await pool.query("SELECT version FROM isocache.schema_migrations")).rowCount,
        1,
      );
    },
  );
});
