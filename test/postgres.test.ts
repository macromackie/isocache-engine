import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createPostgresSync, migrateSync, pruneViews, SyncError } from '../src/postgres.js';
import type { ApplicationSync, DecodedOperation } from '../src/postgres.js';
import type { Outcome, VersionedRow, PushRequest, PullRequest, Updates } from '../src/protocol.js';
import { disposablePostgres } from '../src/testing.js';

type Command = { key: string; value: string; result?: 'reject' | 'notice' | 'fail' };
type Entity = { key: string; value: string };

test('Postgres protocol durability and account isolation', { timeout: 60_000 }, async (t) => {
  const database = await disposablePostgres({ owner: 'isocache-engine-tests' });
  t.after(() => database.stop());
  const { pool } = database;
  await migrateSync(pool);
  await migrateSync(pool);
  await pool.query(
    'CREATE TABLE items(owner_id text NOT NULL, key text NOT NULL, value text NOT NULL, version bigint NOT NULL DEFAULT 1, PRIMARY KEY(owner_id,key))',
  );
  let failure = true;
  const application: ApplicationSync<Command, Entity> = {
    async apply(tx, context, command): Promise<Outcome> {
      await tx.query(
        'INSERT INTO items(owner_id,key,value) VALUES($1,$2,$3) ON CONFLICT(owner_id,key) DO UPDATE SET value=$3, version=items.version+1',
        [context.principalID, command.key, command.value],
      );
      if (command.result === 'fail' && failure) throw new Error('Unavailable database dependency');
      if (command.result === 'reject')
        return { status: 'rejected', code: 'conflict', message: 'Edit conflicts.' };
      if (command.result === 'notice')
        return { status: 'appliedWithNotice', code: 'adjusted', message: 'Saved with a notice.' };
      return { status: 'accepted', recipients: [context.principalID] };
    },
    async readView(tx, context) {
      const result = await tx.query(
        'SELECT key,value,version::text FROM items WHERE owner_id=$1 ORDER BY key',
        [context.principalID],
      );
      return {
        rows: result.rows.map(({ key, value, version }) => ({
          key,
          version,
          value: { key, value },
        })),
      };
    },
  };
  const engine = createPostgresSync({ pool, application });
  const operation = (sequence: number, command: Command): DecodedOperation<Command> => ({
    id: randomUUID(),
    sequence,
    name: 'set',
    args: command,
    command,
  });
  const push = (principalID: string, clientID: string, operations: DecodedOperation<Command>[]) =>
    engine.push({ principalID, request: { version: 2, clientID, operations } });
  const pull = (principalID: string, clientID: string, cookie: string | null = null) =>
    engine.pull({ principalID, request: { version: 2, clientID, cookie } });
  const conflict = (error: unknown) => error instanceof SyncError && error.status === 409;

  await t.test(
    'duplicates are immutable and a committed prefix survives an infrastructure failure',
    async () => {
      const client = randomUUID();
      const first = operation(1, { key: 'a', value: 'first' });
      const second = operation(2, { key: 'b', value: 'second', result: 'fail' });
      await assert.rejects(push('prefix', client, [first, second]), /Unavailable/);
      const prefix = await pull('prefix', client);
      assert.equal(prefix.lastSequence, 1);
      assert.deepEqual(
        prefix.put.map((row) => row.value),
        [{ key: 'a', value: 'first' }],
      );
      failure = false;
      await push('prefix', client, [first, second]);
      await push('prefix', client, [first, second]);
      const final = await pull('prefix', client, prefix.cookie);
      assert.equal(final.lastSequence, 2);
      assert.deepEqual(
        final.put.map((row) => row.value),
        [{ key: 'b', value: 'second' }],
      );
      await assert.rejects(
        push('prefix', client, [operation(4, { key: 'gap', value: 'bad' })]),
        conflict,
      );
      await assert.rejects(
        push('prefix', client, [
          {
            ...first,
            args: { key: 'a', value: 'changed' },
            command: { key: 'a', value: 'changed' },
          },
        ]),
        conflict,
      );
      await assert.rejects(push('prefix', client, [operation(1, first.command)]), conflict);
      await push('prefix', client, [{ ...first, command: { ...first.command, result: 'fail' } }]);
      await assert.rejects(
        push('prefix', client, [{ ...first, name: 'differentMutator' }]),
        conflict,
      );
    },
  );

  await t.test(
    'terminal rejections roll back application writes and preserve UUID binding',
    async () => {
      const client = randomUUID();
      const rejected = operation(1, { key: 'bad', value: 'must not appear', result: 'reject' });
      const notice = operation(2, { key: 'good', value: 'saved', result: 'notice' });
      await push('outcomes', client, [rejected, notice]);
      const update = await pull('outcomes', client);
      assert.equal(update.lastSequence, 2);
      assert.deepEqual(
        update.put.map((row) => row.key),
        ['good'],
      );
      assert.deepEqual(
        update.rejections.map(({ id, code, status }) => ({ id, code, status })),
        [
          { id: rejected.id, code: 'conflict', status: 'rejected' },
          { id: notice.id, code: 'adjusted', status: 'appliedWithNotice' },
        ],
      );
      assert.equal((await pull('outcomes', client, update.cookie)).rejections.length, 0);
      assert.equal((await pull('outcomes', client)).rejections.length, 2);
      await assert.rejects(
        push('outcomes', randomUUID(), [{ ...rejected, sequence: 1 }]),
        conflict,
      );
      await assert.rejects(push('outcomes', client, [{ ...rejected, sequence: 3 }]), conflict);
    },
  );

  await t.test('UUID reuse racing across clients produces one terminal operation', async () => {
    const shared = operation(1, { key: 'race', value: 'once' });
    const results = await Promise.allSettled([
      push('race', randomUUID(), [shared]),
      push('race', randomUUID(), [{ ...shared, id: shared.id!.toUpperCase() }]),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const failed = results.find((result) => result.status === 'rejected');
    assert.ok(failed?.status === 'rejected' && conflict(failed.reason));
    const row = await pool.query('SELECT version FROM items WHERE owner_id=$1 AND key=$2', [
      'race',
      'race',
    ]);
    assert.equal(Number(row.rows[0].version), 1);
  });

  await t.test(
    'authorized removals, CVR loss, receipt replay, and cross-account client isolation',
    async () => {
      const client = randomUUID();
      await push('owner', client, [operation(1, { key: '__proto__', value: 'safe' })]);
      const first = await pull('owner', client);
      assert.deepEqual(
        first.put.map((row) => row.key),
        ['__proto__'],
      );
      await pool.query('DELETE FROM items WHERE owner_id=$1', ['owner']);
      const removal = await pull('owner', client, first.cookie);
      assert.deepEqual(removal.del, ['__proto__']);
      assert.ok(removal.order > first.order);
      await assert.rejects(
        pull('intruder', client),
        (error) => error instanceof SyncError && error.status === 403,
      );
      const other = await pull('intruder', randomUUID(), removal.cookie);
      assert.equal(other.clear, true);
      assert.equal(other.put.length, 0);
      await pool.query("UPDATE isocache.client_views SET created_at=now()-interval '8 days'");
      assert.equal(await pruneViews(pool, { limit: 1 }), 1);
      const reset = await pull('owner', client, removal.cookie);
      assert.equal(reset.clear, true);
      assert.equal(reset.lastSequence, 1);
      assert.equal(
        (
          await pool.query('SELECT count(*) FROM isocache.operation_receipts WHERE client_id=$1', [
            client,
          ])
        ).rows[0].count,
        '1',
      );
    },
  );

  await t.test(
    'pull projection and metadata come from a consistent snapshot during another write',
    async () => {
      const writer = randomUUID();
      await push('snapshot', writer, [
        operation(1, { key: 'one', value: 'old' }),
        operation(2, { key: 'two', value: 'old' }),
      ]);
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const snapshotEngine = createPostgresSync({
        pool,
        application: {
          ...application,
          async readView(tx, context) {
            const first = await tx.query(
              'SELECT key,value,version::text FROM items WHERE owner_id=$1 AND key=$2',
              [context.principalID, 'one'],
            );
            entered.resolve();
            await resume.promise;
            const second = await tx.query(
              'SELECT key,value,version::text FROM items WHERE owner_id=$1 AND key=$2',
              [context.principalID, 'two'],
            );
            const rows: VersionedRow<Entity>[] = [...first.rows, ...second.rows].map(
              ({ key, value, version }) => ({ key, version, value: { key, value } }),
            );
            return { rows };
          },
        },
      });
      const pending = snapshotEngine.pull({
        principalID: 'snapshot',
        request: { version: 2, clientID: randomUUID(), cookie: null },
      });
      await entered.promise;
      try {
        await push('snapshot', writer, [operation(3, { key: 'two', value: 'new' })]);
      } finally {
        resume.resolve();
      }
      assert.deepEqual(
        (await pending).put.map((row) => row.value.value),
        ['old', 'old'],
      );
    },
  );

  await t.test(
    'legacy metadata keeps v1 cookies and v2 acknowledgements without a migration',
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
            clients: 'sync_clients',
            receipts: 'operation_receipts',
            views: 'client_views',
          },
          receiptIdentity: 'sequence',
        },
      });
      const clientID = randomUUID();
      await legacy.push({
        principalID: 'legacy',
        request: {
          version: 1,
          clientID,
          operations: [{ sequence: 1, command: { key: 'old', value: 'kept' } }],
        },
      });
      const first = await legacy.pull({
        principalID: 'legacy',
        request: { version: 1, clientID, cookie: null },
      });
      await legacy.push({
        principalID: 'legacy',
        request: {
          version: 2,
          clientID,
          operations: [
            { id: randomUUID(), sequence: 1, command: { key: 'old', value: 'duplicate' } },
            {
              id: randomUUID(),
              sequence: 2,
              command: { key: 'rejected', value: 'bad', result: 'reject' },
            },
          ],
        },
      });
      const v1 = await legacy.pull({
        principalID: 'legacy',
        request: { version: 1, clientID, cookie: first.cookie },
      });
      assert.equal(v1.cookie, first.cookie);
      assert.equal(v1.lastSequence, 2);
      assert.deepEqual(v1.rejections, [{ sequence: 2, error: 'Edit conflicts.' }]);
      const v2 = await legacy.pull({
        principalID: 'legacy',
        request: { version: 2, clientID, cookie: v1.cookie },
      });
      assert.notEqual(v2.cookie, v1.cookie);
      assert.deepEqual(v2.rejections, v1.rejections);
      const acknowledged = await legacy.pull({
        principalID: 'legacy',
        request: { version: 2, clientID, cookie: v2.cookie },
      });
      assert.equal(acknowledged.rejections.length, 0);
    },
  );

  await t.test('the shared Swift v2 fixture reaches the typed application boundary', async () => {
    type Value = { type: 'value'; key: string; value: number };
    const fixture = JSON.parse(
      await readFile(new URL('fixtures/v2.json', import.meta.url), 'utf8'),
    ) as {
      operations: PushRequest<{ key: string; value: number }>;
      request: PullRequest;
      updates: Updates<Value>;
    };
    const fixtureEngine = createPostgresSync<{ key: string; value: number }, Value>({
      pool,
      application: {
        async apply(tx, context, command) {
          if (context.sequence === 6)
            return { status: 'rejected', code: 'conflict', message: 'The value changed.' };
          await tx.query(
            'INSERT INTO items(owner_id,key,value) VALUES($1,$2,$3) ON CONFLICT(owner_id,key) DO UPDATE SET value=$3',
            [context.principalID, command.key, String(command.value)],
          );
          return { status: 'accepted' };
        },
        async readView(tx, context) {
          const result = await tx.query('SELECT key,value FROM items WHERE owner_id=$1', [
            context.principalID,
          ]);
          return {
            rows: result.rows.map(({ key, value }) => ({
              key: `value/${key}`,
              version: `revision-${value}`,
              value: { type: 'value' as const, key, value: Number(value) },
            })),
          };
        },
      },
    });
    const wire = fixture.operations.operations[0]!;
    const prefix = Array.from({ length: 6 }, (_, index) => ({
      ...wire,
      id: index === 5 ? fixture.updates.rejections[0]!.id! : randomUUID(),
      sequence: index + 1,
      command: wire.args,
    }));
    await fixtureEngine.push({
      principalID: 'wire',
      request: { ...fixture.operations, operations: [...prefix, { ...wire, command: wire.args }] },
    });
    const response = await fixtureEngine.pull({ principalID: 'wire', request: fixture.request });
    assert.deepEqual(
      { ...response, cookie: fixture.updates.cookie, order: fixture.updates.order },
      fixture.updates,
    );
  });
});
