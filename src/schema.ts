import type { Pool } from 'pg';
import { transaction } from './transaction.js';

export type MetadataLayout = {
  tables: { clients: string; receipts: string; views: string };
  receiptIdentity: 'sequence' | 'operation';
};

export function resolveMetadata(
  layout: MetadataLayout = {
    tables: {
      clients: 'isocache.sync_clients',
      receipts: 'isocache.operation_receipts',
      views: 'isocache.client_views',
    },
    receiptIdentity: 'operation',
  },
) {
  function identifier(value: string) {
    if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(value))
      throw new Error('Invalid Postgres metadata table identifier.');
    return value
      .split('.')
      .map((part) => `"${part}"`)
      .join('.');
  }
  return {
    clients: identifier(layout.tables.clients),
    receipts: identifier(layout.tables.receipts),
    views: identifier(layout.tables.views),
    receiptIdentity: layout.receiptIdentity,
  };
}

export async function migrateSync(pool: Pool): Promise<void> {
  await transaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('isocache/migrations', 0))");
    await tx.query(`
      CREATE SCHEMA IF NOT EXISTS isocache;
      CREATE TABLE IF NOT EXISTS isocache.sync_clients (
        id uuid PRIMARY KEY,
        owner_id text NOT NULL,
        last_sequence bigint NOT NULL DEFAULT 0,
        protocol_version integer NOT NULL DEFAULT 2,
        last_seen_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS isocache.operation_receipts (
        client_id uuid NOT NULL REFERENCES isocache.sync_clients(id) ON DELETE CASCADE,
        sequence bigint NOT NULL,
        operation_id uuid NOT NULL UNIQUE,
        command jsonb NOT NULL,
        status text NOT NULL CHECK (status IN ('accepted', 'rejected', 'appliedWithNotice')),
        code text,
        error text,
        mutator text,
        processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY(client_id, sequence)
      );
      CREATE SEQUENCE IF NOT EXISTS isocache.client_view_order;
      CREATE TABLE IF NOT EXISTS isocache.client_views (
        id uuid PRIMARY KEY,
        client_id uuid NOT NULL REFERENCES isocache.sync_clients(id) ON DELETE CASCADE,
        versions jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        cookie_order bigint NOT NULL DEFAULT nextval('isocache.client_view_order'),
        last_sequence bigint NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS client_views_created ON isocache.client_views(created_at);
    `);
  });
}
