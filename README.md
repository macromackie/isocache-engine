# Isocache Engine

Isocache Engine synchronizes offline applications against Postgres. It owns ordered client transactions,
durable operation receipts, and client view records (CVRs). Applications own authentication, domain tables,
authorization, commands, and the rows each account can read.

The package ships compiled JavaScript and TypeScript declarations. Its public modules are `protocol`,
`postgres`, `cloudflare`, and `testing`. It has no web framework or authentication dependency.

## Install

Install the compiled release artifact and commit the resulting lockfile:

```sh
pnpm add https://github.com/macromackie/isocache-engine/releases/download/v0.2.1/macromackie-isocache-engine-0.2.1.tgz
```

Import from `@macromackie/isocache-engine/postgres` or the other explicit exports. The release tarball contains
compiled modules; consumers do not compile this repository or need its example tooling.

## Application adapter

Create one `createPostgresSync` adapter from [the Postgres API](src/postgres.ts). `apply` receives the active
Postgres transaction, authenticated principal, immutable operation ID, client ID, and sequence. It returns
an accepted, rejected, or applied-with-notice outcome and the principals whose views may have changed.
Rejected and applied-with-notice outcomes require a stable `code` and a readable `message`.
Accepted outcomes carry neither. The engine validates this boundary for JavaScript callers too.
All authorization and resource locks belong inside that transaction. Callbacks can run again after a
serialization failure; put durable external work in an application outbox.

An optional `authorize(tx, { principalID })` callback runs before client metadata is read or created in every push
operation and pull transaction. Use it to lock and validate an application-owned principal record. Throw when the
principal no longer has access; a rejection outcome would still commit sync metadata. This callback does not
replace authorization of individual resources in `apply` and `readView`. Empty push requests create no transaction
or metadata and do not call it.

`readView` returns authorized `{ key, version, value }` rows from the supplied transaction. Versions are string
equality tokens: an unchanged version must always mean the same serialized value. Rows omitted from the next
view become deletions. A typed extension is read in the same snapshot for existing application sidecars. Supplying an extension type makes its field required in both the adapter and pull result.
Extensions do not participate in CVR ordering; put synchronized application data in versioned rows.

Authenticate and decode commands before calling the adapter. The engine validates envelope IDs and sequences;
the application validates command arguments and capability negotiation. The [local example](examples/worker.ts)
shows the complete adapter and request mapping. Its fixed principal is for loopback development only.

## Durability

`migrateSync(pool)` records numbered migrations in `isocache.schema_migrations` and creates metadata in the `isocache` Postgres schema. It adopts populated 0.1 installations without changing their clients, receipts, or CVRs. Each operation commits separately, so a
batch can commit a prefix before a later infrastructure failure. Retrying identical operations is safe.
Accepted and applied-with-notice results commit domain changes and receipts together. Rejections roll domain
changes back to a savepoint but still commit their terminal receipt. Exceptions consume no sequence.

Every terminal operation UUID is bound permanently to one client, sequence, and original mutation name and arguments, including
rejections. A different binding fails with a conflict. Reusing a client under another principal is forbidden.
Do not delete receipt or client metadata while that identity could retry old work or a domain token could
reference its operation IDs. Normal cleanup must preserve those identities. Explicit principal erasure ends the
deleted principal's retry guarantee and replaces full bindings with opaque UUID reservations, as described below.

Pulls read the projection, receipts, and CVR in one repeatable-read transaction. A missing or expired CVR
produces a clear/reset patch and resends unresolved rejection receipts. Acknowledgement advances only through
the last sequence recorded in the supplied CVR. Clear/reset never means the client should erase its outbox.
`pruneViews` removes a bounded number of expired CVRs globally; it never prunes operation identities.

### Principal erasure

`erasePrincipal(tx, principalID, { metadata? })` deletes that principal's client records, operation receipts
(including saved command arguments), and CVRs. It returns the number of deleted clients. It uses the caller's
active transaction and leaves application data and other principals' metadata alone. It also works with explicitly
configured legacy layouts whose foreign keys do not cascade.

For operation-identity layouts, erasure first reserves every terminal operation UUID in a table containing only
`operation_id`. It retains no principal, client, mutation name, arguments or timestamp. Every future operation
checks these reservations and rejects reuse, including another principal reusing an old overwritten edit token.
Erasure and UUID binding take the same advisory lock so a concurrent request cannot pass between the reservation
check and receipt removal. Reservations are permanent; ordinary cleanup never deletes them.

Call it only when permanently retiring an application principal. Revoke that principal's sessions/access and
coordinate deletion with the same application-owned principal lock used by `authorize`. Take that lock before
metadata locks. Delete application records and erase sync metadata in the same transaction. On rollback, both
remain. A previously authenticated request must fail inside `authorize` after deletion, including a pull that
would otherwise create a fresh client. Checking a session only before entering the engine does not provide this
guarantee. The engine has no authentication database or permanent deleted-principal registry of its own.

Do not use erasure to reset a device, retry a failed operation, expire a session, or clear old CVRs. The retired
principal must never be admitted again. Applications own retention or anonymization of shared domain history and
must still advance the edit token on every accepted edit. Sequence-identity layouts have no global operation-UUID
binding or retirement reservations; they retain their weaker client/sequence guarantees.

Operation layouts use `isocache.retired_operations` by default. Run `migrateSync` before using version 0.2.1.
A custom operation layout can set `metadata.tables.retiredOperations` to a validated table name and own its migration;
the table must have `operation_id uuid PRIMARY KEY`. Use the same layout for pushes, pulls and erasure. Missing
reservation tables fail the transaction rather than silently weakening identity protection.

Existing installations can supply a `MetadataLayout` with validated table identifiers and
`receiptIdentity: 'sequence'`. This preserves client/sequence deduplication against existing columns without
applying migrations or requiring UUID bindings. Its tables need the common columns in [the baseline migration](src/postgres/migrations.ts);
receipts omit `operation_id`, `command`, `status`, and `code`. The request version controls v1 cookie reuse and
receipt replay independently of the layout. New applications use the default `isocache` tables and
`receiptIdentity: 'operation'`, which enforce UUID binding. The table layout is Postgres configuration, not
an alternate persistence interface.

`PokeHub` and `pokeTransport` provide optional Cloudflare WebSocket hints. Authenticate before routing a
principal to its hub. A poke says only `poke`; every authoritative change arrives through pull. Reconnect and
periodic foreground pulls recover lost hints. The exported transport reports failures so applications can
choose their logging and retry policy after writes have committed.

## Upgrade from 0.1

Version 0.2 keeps the existing wire envelope and metadata columns. Run `migrateSync` for default-layout databases
to adopt the migration ledger; applications with their own sequence-identity layout keep their own migrations.
Update rejected and applied-with-notice adapter results to include both `code` and `message`.
Remove error fields from accepted outcomes. No client reset or receipt deletion is required.

The Postgres implementation now has focused modules under [src/postgres](src/postgres).
Only the explicitly exported package entry points are public. Internal metadata reads validate stored values,
and rollback failures discard the connection while preserving the original error.

Version 0.2.1 adds the UUID-only retirement ledger. Run `migrateSync` before using the new engine against default
metadata, including an existing 0.2 installation. Adopt the transactional `authorize` hook when implementing
principal erasure so an already authenticated request cannot recreate client metadata after deletion.

## Local example

Install the pinned Node and pnpm versions through mise, then run:

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
docker compose -f examples/compose.yaml up -d --wait
mise exec -- pnpm example:migrate
mise exec -- pnpm example:dev
```

The same Worker and Postgres configuration can run with
`mise exec github:denoland/celld@0.6.2 -- pnpm example:celld`.
This repository provides the Worker and database configuration; a consuming application's development tools
own process lifetimes and build identity. The example uses local demo credentials only.

Send a command and pull the resulting row:

```sh
curl --fail http://localhost:8799/push -H 'Content-Type: application/json' \
  -d '{"version":2,"clientID":"00000000-0000-4000-8000-000000000001","operations":[{"id":"00000000-0000-4000-8000-000000000002","sequence":1,"name":"setNote","args":{"key":"note/1","value":"Saved offline"}}]}'
curl --fail http://localhost:8799/pull -H 'Content-Type: application/json' \
  -d '{"version":2,"clientID":"00000000-0000-4000-8000-000000000001","cookie":null}'
```

Stop the Worker with Ctrl-C and remove the example database with
`docker compose -f examples/compose.yaml down --volumes`.

## Checks

Run `mise run check`. The aggregate command validates contracts, formatting, strict types, typed lint, dependency boundaries, compilation, and Postgres behavior. Tests create one disposable, resource-limited Postgres container and remove it
on completion. They require Docker and never use an existing database. `testing.disposablePostgres` exposes
the same fixture for consuming applications; its caller must always await `stop()`.

See [the synchronization contract](.contracts/001-synchronization/CONTRACT.md) for the package's invariants and
[the protocol types](src/protocol.ts) for the v2 envelope.
