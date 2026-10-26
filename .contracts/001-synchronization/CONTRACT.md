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

Represent accepted, rejected and applied-with-notice outcomes as distinct types. Rejections and notices require a
stable code and a human-readable message. Accepted outcomes carry no failure. Validate external request and stored
metadata values at their boundary; a TypeScript result annotation alone does not validate a database response.

Applications own validation, authorization, shared-resource lock order and domain effects. Supply their adapter the
current transaction rather than opening a separate connection. The package imports no application domain, web
framework or authentication library. Emit best-effort pokes after commit; durable delivery intent belongs in the
same domain transaction as its state change.

## Checks

Run the real Postgres integration suite after changing transaction, receipt or retry behavior. Preserve checks for
duplicates, gaps, committed prefixes, rollback, UUID binding and principal ownership. Review the outcome union and
application adapters together. Verify a previous engine schema upgrades without losing terminal identity records.
