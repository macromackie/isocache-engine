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
