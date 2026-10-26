import type { Pool } from "pg";
import { integer, field, object } from "./validation.js";
import { transaction } from "./transaction.js";

const migrations = [
  {
    version: 1,
    sql: `
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
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS isocache.retired_operations (
        operation_id uuid PRIMARY KEY
      );
    `,
  },
];

export async function migrateSync(pool: Pool): Promise<void> {
  await transaction(pool, async (tx) => {
    await tx.query("SET LOCAL lock_timeout = '5s'");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('isocache/migrations', 0))");
    await tx.query(`
      CREATE SCHEMA IF NOT EXISTS isocache;
      CREATE TABLE IF NOT EXISTS isocache.schema_migrations (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    const result = await tx.query("SELECT version FROM isocache.schema_migrations");
    const applied = new Set(
      result.rows.map((raw: unknown) =>
        integer(field(object(raw, "stored migration"), "version"), "stored migration version"),
      ),
    );
    for (const version of applied) {
      if (!migrations.some((migration) => migration.version === version))
        throw new Error("Database requires a newer Isocache Engine migration.");
    }
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      await tx.query(migration.sql);
      await tx.query("INSERT INTO isocache.schema_migrations(version) VALUES ($1)", [
        migration.version,
      ]);
    }
  });
}
