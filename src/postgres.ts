import type { Pool, PoolClient } from 'pg';
import { diff } from './protocol.js';
import type { Outcome, Receipt, Updates, VersionedRow } from './protocol.js';
import { resolveMetadata } from './schema.js';
import type { MetadataLayout } from './schema.js';
import { SyncError, transaction } from './transaction.js';

export { migrateSync } from './schema.js';
export { SyncError, transaction } from './transaction.js';
export type { MetadataLayout } from './schema.js';

export type OperationContext = {
  principalID: string;
  clientID: string;
  sequence: number;
  operationID: string | undefined;
};
export type ViewContext = { principalID: string; clientID: string; schema: number };
export type DecodedOperation<Command> = {
  id?: string;
  sequence: number;
  name?: string;
  args?: unknown;
  command: Command;
};
export type ApplicationSync<Command, Entity, Extension = undefined> = {
  apply(tx: PoolClient, context: OperationContext, command: Command): Promise<Outcome>;
  readView(
    tx: PoolClient,
    context: ViewContext,
  ): Promise<{
    rows: readonly VersionedRow<Entity>[];
    extension?: Extension;
  }>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateID(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !uuid.test(id))
    throw new SyncError('Invalid sync identifier.', 400);
}

export function createPostgresSync<Command, Entity, Extension = undefined>({
  pool,
  application,
  metadata,
}: {
  pool: Pool;
  application: ApplicationSync<Command, Entity, Extension>;
  metadata?: MetadataLayout;
}) {
  const names = resolveMetadata(metadata);

  async function lockClient(tx: PoolClient, principalID: string, clientID: string, version: 1 | 2) {
    await tx.query(
      `INSERT INTO ${names.clients}(id, owner_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [clientID, principalID],
    );
    const {
      rows: [client],
    } = await tx.query(
      `SELECT owner_id, last_sequence FROM ${names.clients} WHERE id = $1 FOR UPDATE`,
      [clientID],
    );
    if (client.owner_id !== principalID)
      throw new SyncError('Client belongs to another account.', 403);
    await tx.query(
      `UPDATE ${names.clients} SET protocol_version = $2, last_seen_at = now() WHERE id = $1`,
      [clientID, version],
    );
    return Number(client.last_sequence);
  }

  async function push({
    principalID,
    request,
  }: {
    principalID: string;
    request: { version: 1 | 2; clientID: string; operations: readonly DecodedOperation<Command>[] };
  }): Promise<Set<string>> {
    validateID(request.clientID);
    if (request.operations.length > 100) throw new SyncError('Too many operations.', 400);
    const clientID = request.clientID.toLowerCase();
    const recipients = new Set<string>();
    for (const operation of request.operations) {
      if (!Number.isSafeInteger(operation.sequence) || operation.sequence < 1)
        throw new SyncError('Invalid operation sequence.', 400);
      if (names.receiptIdentity === 'operation') {
        validateID(operation.id);
        if (typeof operation.name !== 'string' || !Object.hasOwn(operation, 'args'))
          throw new SyncError('Include the original mutation name and arguments.', 400);
      }
      const operationID = operation.id?.toLowerCase();
      const mutation = JSON.stringify({ name: operation.name, args: operation.args });
      const committedRecipients = await transaction(
        pool,
        async (tx) => {
          const last = await lockClient(tx, principalID, clientID, request.version);
          if (names.receiptIdentity === 'operation') {
            // Across different clients the UUID lock precedes checking its immutable receipt binding.
            await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [operationID]);
            const {
              rows: [binding],
            } = await tx.query(
              `SELECT client_id, sequence, command = $2::jsonb AS same_command FROM ${names.receipts} WHERE operation_id = $1`,
              [operationID, mutation],
            );
            if (
              binding &&
              (binding.client_id !== clientID ||
                Number(binding.sequence) !== operation.sequence ||
                !binding.same_command)
            )
              throw new SyncError('Operation identifier is already bound to different work.', 409);
            if (operation.sequence <= last && !binding)
              throw new SyncError(
                'Operation sequence is already bound to another identifier.',
                409,
              );
          }
          if (operation.sequence <= last) return [];
          if (operation.sequence !== last + 1)
            throw new SyncError('Operation sequence has a gap.', 409);
          await tx.query('SAVEPOINT application_operation');
          const outcome = await application.apply(
            tx,
            {
              principalID,
              clientID,
              sequence: operation.sequence,
              operationID,
            },
            operation.command,
          );
          if (outcome.status === 'rejected')
            await tx.query('ROLLBACK TO SAVEPOINT application_operation');
          await tx.query('RELEASE SAVEPOINT application_operation');
          const error =
            outcome.status === 'accepted'
              ? null
              : (outcome.message ?? outcome.code ?? outcome.status);
          if (names.receiptIdentity === 'operation') {
            await tx.query(
              `INSERT INTO ${names.receipts}(client_id, sequence, operation_id, command, status, code, error, mutator) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [
                clientID,
                operation.sequence,
                operationID,
                mutation,
                outcome.status,
                outcome.code ?? null,
                error,
                operation.name ?? null,
              ],
            );
          } else {
            await tx.query(
              `INSERT INTO ${names.receipts}(client_id, sequence, error, mutator) VALUES ($1,$2,$3,$4)`,
              [clientID, operation.sequence, error, operation.name ?? null],
            );
          }
          await tx.query(`UPDATE ${names.clients} SET last_sequence = $2 WHERE id = $1`, [
            clientID,
            operation.sequence,
          ]);
          return outcome.recipients ?? [principalID];
        },
        names.receiptIdentity === 'operation' ? 'READ COMMITTED' : 'REPEATABLE READ',
      );
      for (const recipient of committedRecipients) recipients.add(recipient);
    }
    return recipients;
  }

  async function pull({
    principalID,
    request,
  }: {
    principalID: string;
    request: { version: 1 | 2; clientID: string; cookie: string | null; schema?: number | undefined };
  }): Promise<Updates<Entity> & { extension?: Extension }> {
    validateID(request.clientID);
    if (request.cookie !== null) validateID(request.cookie);
    return transaction(pool, async (tx) => {
      const lastSequence = await lockClient(tx, principalID, request.clientID, request.version);
      const {
        rows: [previous],
      } = await tx.query(
        `SELECT versions, cookie_order, last_sequence FROM ${names.views} WHERE id = $1 AND client_id = $2 AND created_at > now() - interval '7 days'`,
        [request.cookie, request.clientID],
      );
      const view = await application.readView(tx, {
        principalID,
        clientID: request.clientID,
        schema: request.schema ?? 0,
      });
      const { versions, put, del } = diff(view.rows, previous?.versions ?? {});
      const unchanged =
        previous &&
        put.length === 0 &&
        del.length === 0 &&
        (request.version === 1 || Number(previous.last_sequence) === lastSequence);
      let cookie = request.cookie!;
      let order = Number(previous?.cookie_order ?? 0);
      if (!unchanged) {
        cookie = crypto.randomUUID();
        const inserted = await tx.query(
          `INSERT INTO ${names.views}(id, client_id, versions, last_sequence) VALUES ($1,$2,$3,$4) RETURNING cookie_order`,
          [cookie, request.clientID, versions, lastSequence],
        );
        order = Number(inserted.rows[0].cookie_order);
      }
      const after = request.version === 2 && previous ? Number(previous.last_sequence) : 0;
      const columns =
        names.receiptIdentity === 'operation'
          ? 'sequence, error, operation_id, code, status'
          : 'sequence, error';
      const receipts = await tx.query(
        `SELECT ${columns} FROM ${names.receipts} WHERE client_id = $1 AND sequence > $2 AND error IS NOT NULL ORDER BY sequence`,
        [request.clientID, after],
      );
      const rejections: Receipt[] = receipts.rows.map((row) => {
        const receipt: Receipt = { sequence: Number(row.sequence), error: row.error };
        if (names.receiptIdentity === 'operation') {
          receipt.id = row.operation_id;
          receipt.status = row.status;
          if (row.code !== null) receipt.code = row.code;
        }
        return receipt;
      });
      await tx.query(
        `DELETE FROM ${names.views} WHERE id IN (SELECT id FROM ${names.views} WHERE client_id = $1 AND created_at < now() - interval '7 days' LIMIT 100)`,
        [request.clientID],
      );
      const result: Updates<Entity> & { extension?: Extension } = {
        version: 2,
        cookie,
        order,
        clear: !previous,
        put,
        del,
        lastSequence,
        rejections,
      };
      if (view.extension !== undefined) result.extension = view.extension;
      return result;
    });
  }

  return { push, pull };
}

export async function pruneViews(
  pool: Pool,
  { limit = 1000, metadata }: { limit?: number; metadata?: MetadataLayout } = {},
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
    throw new Error('Invalid view cleanup limit.');
  const { views } = resolveMetadata(metadata);
  const result = await pool.query(
    `DELETE FROM ${views} WHERE id IN (SELECT id FROM ${views} WHERE created_at < now() - interval '7 days' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)`,
    [limit],
  );
  return result.rowCount ?? 0;
}
