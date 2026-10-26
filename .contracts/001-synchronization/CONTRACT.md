---
name: synchronization
message: Preserve operation identity and commit each terminal outcome with its sequence and domain effect.
paths:
  [
    "src/postgres/**/*.ts",
    "src/protocol.ts",
    "src/postgres.ts",
    "src/transaction.ts",
    "test/**/*.ts",
  ]
---

# Operation transactions

## Rules

Client metadata belongs to one authenticated principal. Serialize each client's operations in sequence order.
Commit each operation independently, including its domain changes, terminal receipt and sequence advancement.
An infrastructure failure consumes no sequence. A rejection consumes its sequence while rolling domain changes
back. An applied-with-notice outcome commits its domain changes. Domain callbacks tolerate transaction retries.

Bind every terminal UUID to exactly one client, sequence, original mutation name and original arguments. Bind
rejected UUIDs too, and preserve this identity independently of disposable CVRs. The explicitly configured sequence
identity layout preserves supported legacy client/sequence semantics without migrating application tables.

Permit explicit principal erasure only when the application permanently retires that principal. Delete its clients,
receipts and CVRs through `erasePrincipal` in the caller's transaction while preserving other principals and domain
data. For operation-identity layouts, first reserve all terminal UUIDs in an opaque ledger containing only the UUID,
with no principal, client, mutation arguments or identifying metadata. Check that ledger under the same UUID lock
before admitting any operation, including another principal's reuse of an old overwritten token. Retain these
reservations permanently. A rollback must restore erased metadata and remove uncommitted reservations together.
Support configured legacy layouts without requiring cascading foreign keys. Sequence-identity layouts do not
promise global UUID binding or reservations. Ordinary pruning and recovery never invoke erasure.

Use a validated retirement-table name for operation layouts, with the migrated default as the fallback. A missing
retirement table must fail rather than disable reservations. Applications using a custom table own its migration and
must use the same layout for sync and erasure. Domain adapters must still advance edit tokens on every accepted edit.

Represent accepted, rejected and applied-with-notice outcomes as distinct types. Rejections and notices require a
stable code and a human-readable message. Accepted outcomes carry no failure. Validate external request and stored
metadata values at their boundary; a TypeScript result annotation alone does not validate a database response.

Applications own validation, authorization, shared-resource lock order and domain effects. Supply their adapter the
current transaction rather than opening a separate connection. The package imports no application domain, web
framework or authentication library. Emit best-effort pokes after commit; durable delivery intent belongs in the
same domain transaction as its state change.

Run an adapter's optional `authorize` callback before client metadata mutation for every operation transaction and
pull. Applications using principal erasure must lock and validate their principal in this callback, throw on revoked
access, and take the same principal lock before erasure. Authentication outside the transaction does not prevent
an in-flight request from recreating erased client metadata. Keep resource authorization in the domain callbacks.

## Checks

Run the real Postgres integration suite after changing transaction, receipt or retry behavior. Preserve checks for
duplicates, gaps, committed prefixes, rollback, UUID binding and principal ownership. Review the outcome union and
application adapters together. Verify a previous engine schema upgrades without losing terminal identity records.
Exercise principal-erasure rollback, another principal's retained receipts/CVRs, and a stale authorized request racing
deletion. Confirm that a legacy non-cascade layout erases its child metadata without touching another owner.
Verify that an overwritten operation UUID remains unusable after erasure, including across principals and through a
configured retirement table. Confirm that retained reservations contain only operation IDs.
