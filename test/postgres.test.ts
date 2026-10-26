import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  createPostgresSync,
  erasePrincipal,
  migrateSync,
  pruneViews,
  SyncError,
  transaction,
} from "../src/postgres.js";
import type { ApplicationSync, DecodedOperation, MetadataLayout } from "../src/postgres.js";
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
    "principal erasure removes private metadata atomically and preserves other owners",
    async () => {
      const erasedClients = [randomUUID(), randomUUID()];
      const erasedOperations: string[] = [];
      const keptClient = randomUUID();
      for (const client of erasedClients) {
        const change = operation(1, { key: "private", value: "retained payload" });
        assert.ok(change.id);
        erasedOperations.push(change.id);
        await push("erase", client, [change]);
        await pull("erase", client);
      }
      await push("erase-kept", keptClient, [operation(1, { key: "other", value: "kept" })]);
      const keptView = await pull("erase-kept", keptClient);
      const metadataCount = async (table: string, clients: string[]) => {
        const result = await pool.query(
          `SELECT count(*) FROM isocache.${table} WHERE client_id = ANY($1::uuid[])`,
          [clients],
        );
        return rowText(result.rows[0], "count");
      };
      const rollback = new Error("Rollback principal erasure");
      await assert.rejects(
        transaction(pool, async (tx) => {
          assert.equal(await erasePrincipal(tx, "erase"), 2);
          throw rollback;
        }),
        (error) => error === rollback,
      );
      assert.equal(await metadataCount("operation_receipts", erasedClients), "2");
      assert.equal(await metadataCount("client_views", erasedClients), "2");
      assert.equal(
        (
          await pool.query(
            "SELECT operation_id FROM isocache.retired_operations WHERE operation_id = ANY($1::uuid[])",
            [erasedOperations],
          )
        ).rowCount,
        0,
      );
      await transaction(pool, async (tx) => {
        assert.equal(await erasePrincipal(tx, "erase"), 2);
        assert.equal(await erasePrincipal(tx, "erase"), 0);
      });
      assert.equal(await metadataCount("operation_receipts", erasedClients), "0");
      assert.equal(await metadataCount("client_views", erasedClients), "0");
      assert.equal(
        (await pool.query("SELECT id FROM isocache.sync_clients WHERE owner_id=$1", ["erase"]))
          .rowCount,
        0,
      );
      const kept = await pull("erase-kept", keptClient, keptView.cookie);
      assert.equal(kept.cookie, keptView.cookie);
      assert.equal(kept.lastSequence, 1);
      assert.equal(await metadataCount("operation_receipts", [keptClient]), "1");
      assert.equal(
        (await pool.query("SELECT key FROM items WHERE owner_id=$1", ["erase"])).rowCount,
        1,
      );
    },
  );

  await t.test(
    "erasure retains only opaque UUID reservations and prevents overwritten token reuse",
    async () => {
      const client = randomUUID();
      const original = operation(1, { key: "score", value: "original private arguments" });
      const overwritten = operation(2, { key: "score", value: "updated" });
      assert.ok(original.id && overwritten.id);
      await push("retired-owner", client, [original, overwritten]);
      await transaction(pool, (tx) => erasePrincipal(tx, "retired-owner"));
      const retained = await pool.query(
        "SELECT to_jsonb(retired)::text AS metadata FROM isocache.retired_operations retired WHERE operation_id = ANY($1::uuid[])",
        [[original.id, overwritten.id]],
      );
      assert.equal(retained.rowCount, 2);
      for (const raw of retained.rows) {
        const metadata: unknown = JSON.parse(rowText(raw, "metadata"));
        assert.ok(metadata !== null && typeof metadata === "object");
        assert.deepEqual(Object.keys(metadata), ["operation_id"]);
      }
      await assert.rejects(
        push("different-owner", randomUUID(), [{ ...original, sequence: 1 }]),
        conflict,
      );
      assert.equal(
        (await pool.query("SELECT key FROM items WHERE owner_id=$1", ["different-owner"])).rowCount,
        0,
      );
      const preserved = await pool.query("SELECT value FROM items WHERE owner_id=$1 AND key=$2", [
        "retired-owner",
        "score",
      ]);
      assert.equal(rowText(preserved.rows[0], "value"), "updated");
    },
  );

  await t.test(
    "custom operation layouts preserve reservations in their configured table",
    async () => {
      await pool.query(`
      CREATE TABLE custom_clients (LIKE isocache.sync_clients INCLUDING ALL);
      CREATE TABLE custom_receipts (LIKE isocache.operation_receipts INCLUDING ALL);
      CREATE TABLE custom_views (LIKE isocache.client_views INCLUDING ALL);
      CREATE TABLE custom_retired_operations (operation_id uuid PRIMARY KEY);
    `);
      const metadata: MetadataLayout = {
        tables: {
          clients: "custom_clients",
          receipts: "custom_receipts",
          views: "custom_views",
          retiredOperations: "custom_retired_operations",
        },
        receiptIdentity: "operation",
      };
      const custom = createPostgresSync({ pool, application, metadata });
      const original = operation(1, { key: "private", value: "custom payload" });
      const clientID = randomUUID();
      await custom.push({
        principalID: "custom-owner",
        request: { version: 2, clientID, operations: [original] },
      });
      await transaction(pool, (tx) => erasePrincipal(tx, "custom-owner", { metadata }));
      await assert.rejects(
        custom.push({
          principalID: "custom-other",
          request: { version: 2, clientID: randomUUID(), operations: [original] },
        }),
        conflict,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT operation_id FROM custom_retired_operations WHERE operation_id=$1",
            [original.id],
          )
        ).rowCount,
        1,
      );
      assert.throws(
        () =>
          createPostgresSync({
            pool,
            application,
            metadata: {
              ...metadata,
              tables: { ...metadata.tables, retiredOperations: "invalid;identifier" },
            },
          }),
        /metadata table identifier/,
      );
    },
  );

  await t.test("erasure waits for an in-flight UUID binding check", async () => {
    const client = randomUUID();
    const change = operation(1, { key: "private", value: "reserved" });
    assert.ok(change.id);
    await push("erasure-race", client, [change]);
    const binding = await pool.connect();
    const started = Promise.withResolvers<string>();
    let completed = false;
    let erasure: Promise<number> | undefined;
    try {
      await binding.query("BEGIN");
      await binding.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [change.id]);
      erasure = transaction(pool, async (tx) => {
        const result = await tx.query("SELECT pg_backend_pid()::text AS pid");
        started.resolve(rowText(result.rows[0], "pid"));
        return erasePrincipal(tx, "erasure-race");
      });
      const observed = erasure.then(
        () => {
          completed = true;
        },
        () => {
          completed = true;
        },
      );
      const pid = await started.promise;
      const deadline = performance.now() + 5_000;
      while (true) {
        assert.equal(completed, false, "Erasure passed an in-flight UUID binding check.");
        const waiting = await pool.query(
          "SELECT pid FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND wait_event='advisory'",
          [pid],
        );
        if (waiting.rowCount === 1) break;
        assert.ok(performance.now() < deadline, "Erasure did not reach the UUID lock.");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await binding.query("COMMIT");
      assert.equal(await erasure, 1);
      await observed;
    } finally {
      await binding.query("ROLLBACK");
      binding.release();
      if (erasure) await erasure;
    }
  });

  await t.test(
    "transaction authorization prevents stale requests from recreating erased metadata",
    async () => {
      await pool.query("CREATE TABLE principals (id text PRIMARY KEY)");
      await pool.query("INSERT INTO principals VALUES ($1)", ["erased-principal"]);
      let admission: ReturnType<typeof Promise.withResolvers<void>> | undefined;
      const authorized = createPostgresSync({
        pool,
        application: {
          ...application,
          async authorize(tx, { principalID }) {
            admission?.resolve();
            const result = await tx.query("SELECT id FROM principals WHERE id=$1 FOR KEY SHARE", [
              principalID,
            ]);
            if (result.rowCount !== 1) throw new SyncError("Principal no longer has access.", 403);
          },
        },
      });
      const clientID = randomUUID();
      const pushAuthorized = (sequence: number) =>
        authorized.push({
          principalID: "erased-principal",
          request: {
            version: 2,
            clientID,
            operations: [operation(sequence, { key: "personal", value: "data" })],
          },
        });
      const pullAuthorized = () =>
        authorized.pull({
          principalID: "erased-principal",
          request: { version: 2, clientID, cookie: null },
        });
      await assert.rejects(
        authorized.push({
          principalID: "missing-principal",
          request: {
            version: 2,
            clientID: randomUUID(),
            operations: [operation(1, { key: "forbidden", value: "must not save" })],
          },
        }),
        (error) => error instanceof SyncError && error.status === 403,
      );
      await assert.rejects(
        authorized.pull({
          principalID: "missing-principal",
          request: { version: 2, clientID: randomUUID(), cookie: null },
        }),
        (error) => error instanceof SyncError && error.status === 403,
      );
      await pushAuthorized(1);
      await pullAuthorized();
      const erased = Promise.withResolvers<void>();
      const commit = Promise.withResolvers<void>();
      const deletion = transaction(pool, async (tx) => {
        await tx.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", ["erased-principal"]);
        await erasePrincipal(tx, "erased-principal");
        await tx.query("DELETE FROM principals WHERE id=$1", ["erased-principal"]);
        erased.resolve();
        await commit.promise;
      });
      try {
        await erased.promise;
        admission = Promise.withResolvers<void>();
        const stalePush = pushAuthorized(2);
        const pushDenied = assert.rejects(
          stalePush,
          (error) => error instanceof SyncError && error.status === 403,
        );
        await admission.promise;
        admission = Promise.withResolvers<void>();
        const stalePull = pullAuthorized();
        const pullDenied = assert.rejects(
          stalePull,
          (error) => error instanceof SyncError && error.status === 403,
        );
        await admission.promise;
        commit.resolve();
        await deletion;
        await Promise.all([pushDenied, pullDenied]);
      } finally {
        commit.resolve();
        await deletion;
      }
      assert.equal(
        (
          await pool.query("SELECT id FROM isocache.sync_clients WHERE owner_id=$1", [
            "erased-principal",
          ])
        ).rowCount,
        0,
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
      const metadata: MetadataLayout = {
        tables: {
          clients: "sync_clients",
          receipts: "operation_receipts",
          views: "client_views",
        },
        receiptIdentity: "sequence",
      };
      const legacy = createPostgresSync({
        pool,
        application,
        metadata,
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
      await transaction(pool, async (tx) => {
        assert.equal(await erasePrincipal(tx, "legacy", { metadata }), 1);
      });
      assert.equal(
        (await pool.query("SELECT id FROM sync_clients WHERE id=$1", [clientID])).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query("SELECT client_id FROM operation_receipts WHERE client_id=$1", [
            clientID,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (await pool.query("SELECT client_id FROM client_views WHERE client_id=$1", [clientID]))
          .rowCount,
        0,
      );
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
      const cookie = randomUUID();
      const accepted = operation(1, { key: "kept", value: "saved" });
      const rejected = operation(2, { key: "rejected", value: "not saved", result: "reject" });
      const noticed = operation(3, { key: "notice", value: "saved with notice", result: "notice" });
      await pool.query(
        "INSERT INTO isocache.sync_clients(id,owner_id,last_sequence) VALUES ($1,$2,3)",
        [client, "upgrade"],
      );
      for (const [change, status, code, error] of [
        [accepted, "accepted", null, null],
        [rejected, "rejected", "conflict", "Edit conflicts."],
        [noticed, "appliedWithNotice", "adjusted", "Saved with a notice."],
      ] as const) {
        await pool.query(
          "INSERT INTO isocache.operation_receipts(client_id,sequence,operation_id,command,status,code,error,mutator) VALUES ($1,$2,$3,$4,$5,$6,$7,'set')",
          [
            client,
            change.sequence,
            change.id,
            JSON.stringify({ name: change.name, args: change.args }),
            status,
            code,
            error,
          ],
        );
      }
      await pool.query(
        "INSERT INTO items(owner_id,key,value) VALUES ('upgrade','kept','saved'),('upgrade','notice','saved with notice')",
      );
      await pool.query(
        "INSERT INTO isocache.client_views(id,client_id,versions,last_sequence) VALUES($1,$2,$3,3)",
        [cookie, client, { kept: "1", notice: "1" }],
      );
      const readReceipts = async () => {
        const result = await pool.query(
          "SELECT to_jsonb(receipt)::text AS metadata FROM isocache.operation_receipts receipt WHERE client_id=$1 ORDER BY sequence",
          [client],
        );
        return result.rows.map((row: unknown) => rowText(row, "metadata"));
      };
      const receipts = await readReceipts();
      await migrateSync(pool);
      await migrateSync(pool);
      const after = await pull("upgrade", client, cookie);
      assert.equal(after.cookie, cookie);
      assert.equal(after.lastSequence, 3);
      assert.equal(after.put.length, 0);
      assert.deepEqual(await readReceipts(), receipts);
      assert.equal(
        (await pool.query("SELECT version FROM isocache.schema_migrations")).rowCount,
        2,
      );
    },
  );
});
