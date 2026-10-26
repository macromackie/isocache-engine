import type { Pool } from "pg";
import type { ApplicationSync, DecodedOperation, PushInput } from "./types.js";
import type { MetadataStore } from "./metadata-store.js";
import { identifier, outcome } from "./validation.js";
import { SyncError, transaction } from "./transaction.js";

function prepare<Command>(
  operation: DecodedOperation<Command>,
  identity: "operation" | "sequence",
) {
  if (!Number.isSafeInteger(operation.sequence) || operation.sequence < 1)
    throw new SyncError("Invalid operation sequence.", 400);
  const common = {
    ...operation,
    fingerprint: JSON.stringify({ name: operation.name, args: operation.args }),
  };
  if (identity === "operation") {
    if (typeof operation.name !== "string" || !Object.hasOwn(operation, "args"))
      throw new SyncError("Include the original mutation name and arguments.", 400);
    return { ...common, identity: "operation" as const, operationID: identifier(operation.id) };
  }
  return {
    ...common,
    identity: "sequence" as const,
    operationID: operation.id === undefined ? undefined : identifier(operation.id),
  };
}

export async function pushOperations<Command, Entity, Extension>(
  pool: Pool,
  metadata: MetadataStore,
  application: ApplicationSync<Command, Entity, Extension>,
  { principalID, request }: PushInput<Command>,
): Promise<Set<string>> {
  const clientID = identifier(request.clientID);
  if (request.operations.length > 100) throw new SyncError("Too many operations.", 400);
  const recipients = new Set<string>();
  for (const raw of request.operations) {
    const operation = prepare(raw, metadata.receiptIdentity);
    const committed = await transaction(
      pool,
      async (tx) => {
        const last = await metadata.lockClient(tx, principalID, clientID, request.version);
        if (operation.identity === "operation") {
          await metadata.checkBinding(
            tx,
            clientID,
            operation.sequence,
            last,
            operation.operationID,
            operation.fingerprint,
          );
        }
        if (operation.sequence <= last) return [];
        if (operation.sequence !== last + 1)
          throw new SyncError("Operation sequence has a gap.", 409);
        await tx.query("SAVEPOINT application_operation");
        const result = outcome(
          await application.apply(
            tx,
            {
              principalID,
              clientID,
              sequence: operation.sequence,
              operationID: operation.operationID,
            },
            operation.command,
          ),
        );
        if (result.status === "rejected")
          await tx.query("ROLLBACK TO SAVEPOINT application_operation");
        await tx.query("RELEASE SAVEPOINT application_operation");
        await metadata.recordOperation(tx, {
          clientID,
          sequence: operation.sequence,
          operationID: operation.operationID,
          fingerprint: operation.fingerprint,
          name: operation.name,
          outcome: result,
        });
        return result.recipients ?? [principalID];
      },
      metadata.receiptIdentity === "operation" ? "READ COMMITTED" : "REPEATABLE READ",
    );
    for (const recipient of committed) recipients.add(recipient);
  }
  return recipients;
}
