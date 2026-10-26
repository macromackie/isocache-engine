import type { Pool, PoolClient } from "pg";
import type { Outcome, Receipt } from "../protocol.js";
import { field, integer, object, string, versionMap } from "./validation.js";
import { SyncError } from "./transaction.js";

export type MetadataLayout = {
  tables: { clients: string; receipts: string; views: string; retiredOperations?: string };
  receiptIdentity: "sequence" | "operation";
};

const defaultRetiredOperations = "isocache.retired_operations";

const defaultLayout: MetadataLayout = {
  tables: {
    clients: "isocache.sync_clients",
    receipts: "isocache.operation_receipts",
    views: "isocache.client_views",
    retiredOperations: defaultRetiredOperations,
  },
  receiptIdentity: "operation",
};

function tableIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(value))
    throw new Error("Invalid Postgres metadata table identifier.");
  return value
    .split(".")
    .map((part) => `"${part}"`)
    .join(".");
}

export function createMetadataStore(layout: MetadataLayout = defaultLayout) {
  const names = {
    clients: tableIdentifier(layout.tables.clients),
    receipts: tableIdentifier(layout.tables.receipts),
    views: tableIdentifier(layout.tables.views),
    retiredOperations: tableIdentifier(layout.tables.retiredOperations ?? defaultRetiredOperations),
  };
  const receiptIdentity = layout.receiptIdentity;
  if (receiptIdentity !== "sequence" && receiptIdentity !== "operation")
    throw new Error("Invalid operation receipt identity policy.");

  return {
    receiptIdentity,
    async erasePrincipal(tx: PoolClient, principalID: string) {
      await tx.query(`SELECT id FROM ${names.clients} WHERE owner_id = $1 ORDER BY id FOR UPDATE`, [
        principalID,
      ]);
      if (receiptIdentity === "operation") {
        await tx.query(
          `WITH owned_operations AS MATERIALIZED (
             SELECT receipt.operation_id FROM ${names.receipts} receipt
             JOIN ${names.clients} client ON client.id = receipt.client_id
             WHERE client.owner_id = $1 ORDER BY receipt.operation_id
           )
           SELECT pg_advisory_xact_lock(hashtextextended(operation_id::text, 0)) FROM owned_operations`,
          [principalID],
        );
        await tx.query(
          `INSERT INTO ${names.retiredOperations}(operation_id)
           SELECT receipt.operation_id FROM ${names.receipts} receipt
           JOIN ${names.clients} client ON client.id = receipt.client_id
           WHERE client.owner_id = $1 ON CONFLICT DO NOTHING`,
          [principalID],
        );
      }
      await tx.query(
        `DELETE FROM ${names.receipts} receipt USING ${names.clients} client
         WHERE receipt.client_id = client.id AND client.owner_id = $1`,
        [principalID],
      );
      await tx.query(
        `DELETE FROM ${names.views} stored_view USING ${names.clients} client
         WHERE stored_view.client_id = client.id AND client.owner_id = $1`,
        [principalID],
      );
      const result = await tx.query(`DELETE FROM ${names.clients} WHERE owner_id = $1`, [
        principalID,
      ]);
      return result.rowCount ?? 0;
    },
    async lockClient(tx: PoolClient, principalID: string, clientID: string, version: 1 | 2) {
      await tx.query(
        `INSERT INTO ${names.clients}(id, owner_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [clientID, principalID],
      );
      const result = await tx.query(
        `SELECT owner_id, last_sequence FROM ${names.clients} WHERE id = $1 FOR UPDATE`,
        [clientID],
      );
      const raw: unknown = result.rows[0];
      const row = object(raw, "stored sync client");
      if (string(field(row, "owner_id"), "stored client principal") !== principalID)
        throw new SyncError("Client belongs to another account.", 403);
      const sequence = integer(field(row, "last_sequence"), "stored client sequence");
      await tx.query(
        `UPDATE ${names.clients} SET protocol_version = $2, last_seen_at = now() WHERE id = $1`,
        [clientID, version],
      );
      return sequence;
    },
    async checkBinding(
      tx: PoolClient,
      clientID: string,
      sequence: number,
      last: number,
      operationID: string,
      fingerprint: string,
    ) {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [operationID]);
      const retired = await tx.query(
        `SELECT 1 FROM ${names.retiredOperations} WHERE operation_id = $1`,
        [operationID],
      );
      if (retired.rowCount)
        throw new SyncError("Operation identifier belongs to retired work.", 409);
      const result = await tx.query(
        `SELECT client_id, sequence, command = $2::jsonb AS same_command FROM ${names.receipts} WHERE operation_id = $1`,
        [operationID, fingerprint],
      );
      const raw: unknown = result.rows[0];
      if (raw === undefined) {
        if (sequence <= last)
          throw new SyncError("Operation sequence is already bound to another identifier.", 409);
        return;
      }
      const row = object(raw, "stored operation binding");
      if (
        string(field(row, "client_id"), "stored operation client") !== clientID ||
        integer(field(row, "sequence"), "stored operation sequence") !== sequence ||
        field(row, "same_command") !== true
      )
        throw new SyncError("Operation identifier is already bound to different work.", 409);
    },
    async recordOperation(
      tx: PoolClient,
      input: {
        clientID: string;
        sequence: number;
        operationID: string | undefined;
        fingerprint: string;
        name: string | undefined;
        outcome: Outcome;
      },
    ) {
      const { clientID, sequence, operationID, fingerprint, name, outcome } = input;
      const code = outcome.status === "accepted" ? null : outcome.code;
      const error = outcome.status === "accepted" ? null : outcome.message;
      if (receiptIdentity === "operation") {
        await tx.query(
          `INSERT INTO ${names.receipts}(client_id, sequence, operation_id, command, status, code, error, mutator) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [clientID, sequence, operationID, fingerprint, outcome.status, code, error, name ?? null],
        );
      } else {
        await tx.query(
          `INSERT INTO ${names.receipts}(client_id, sequence, error, mutator) VALUES ($1,$2,$3,$4)`,
          [clientID, sequence, error, name ?? null],
        );
      }
      await tx.query(`UPDATE ${names.clients} SET last_sequence = $2 WHERE id = $1`, [
        clientID,
        sequence,
      ]);
    },
    async readView(tx: PoolClient, clientID: string, cookie: string | null) {
      const result = await tx.query(
        `SELECT versions, cookie_order, last_sequence FROM ${names.views} WHERE id = $1 AND client_id = $2 AND created_at > now() - interval '7 days'`,
        [cookie, clientID],
      );
      const raw: unknown = result.rows[0];
      if (raw === undefined) return undefined;
      const row = object(raw, "stored client view");
      return {
        versions: versionMap(field(row, "versions")),
        order: integer(field(row, "cookie_order"), "stored view order"),
        lastSequence: integer(field(row, "last_sequence"), "stored view sequence"),
      };
    },
    async saveView(
      tx: PoolClient,
      clientID: string,
      cookie: string,
      versions: Record<string, string>,
      lastSequence: number,
    ) {
      const result = await tx.query(
        `INSERT INTO ${names.views}(id, client_id, versions, last_sequence) VALUES ($1,$2,$3,$4) RETURNING cookie_order`,
        [cookie, clientID, versions, lastSequence],
      );
      const raw: unknown = result.rows[0];
      return integer(
        field(object(raw, "created client view"), "cookie_order"),
        "created view order",
      );
    },
    async rejections(tx: PoolClient, clientID: string, after: number): Promise<Receipt[]> {
      const columns =
        receiptIdentity === "operation"
          ? "sequence, error, operation_id, code, status"
          : "sequence, error";
      const result = await tx.query(
        `SELECT ${columns} FROM ${names.receipts} WHERE client_id = $1 AND sequence > $2 AND error IS NOT NULL ORDER BY sequence`,
        [clientID, after],
      );
      return result.rows.map((raw: unknown) => {
        const row = object(raw, "stored operation receipt");
        const sequence = integer(field(row, "sequence"), "stored receipt sequence");
        const error = string(field(row, "error"), "stored receipt error");
        if (receiptIdentity === "sequence") return { sequence, error };
        const status = field(row, "status");
        if (status !== "rejected" && status !== "appliedWithNotice")
          throw new Error("Invalid stored receipt status.");
        const receipt: Receipt = {
          sequence,
          error,
          status,
          id: string(field(row, "operation_id"), "stored operation identifier"),
        };
        const code = field(row, "code");
        if (code !== null) receipt.code = string(code, "stored receipt code");
        return receipt;
      });
    },
    async expireClientViews(tx: PoolClient, clientID: string) {
      await tx.query(
        `DELETE FROM ${names.views} WHERE id IN (SELECT id FROM ${names.views} WHERE client_id = $1 AND created_at < now() - interval '7 days' LIMIT 100)`,
        [clientID],
      );
    },
    async pruneViews(pool: Pool, limit: number) {
      const result = await pool.query(
        `DELETE FROM ${names.views} WHERE id IN (SELECT id FROM ${names.views} WHERE created_at < now() - interval '7 days' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)`,
        [limit],
      );
      return result.rowCount ?? 0;
    },
  };
}

export type MetadataStore = ReturnType<typeof createMetadataStore>;
