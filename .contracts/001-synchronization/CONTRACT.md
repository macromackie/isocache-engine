---
name: synchronization
message: Preserve operation identity, atomic outcomes, consistent views, and principal isolation.
---

# Synchronization

## Rules

Client metadata belongs to one authenticated principal. Serialize each client's operations in sequence order.
Commit each operation independently, including its domain changes, terminal receipt, and sequence advancement.
An infrastructure failure consumes no sequence. A rejection consumes its sequence while rolling domain changes
back. Applied-with-notice outcomes commit their domain changes. Callbacks must tolerate transaction retries.

With operation identity, bind every terminal UUID to exactly one client, sequence, and original mutation name and arguments. Bind rejected
UUIDs too. Preserve this metadata independently of the disposable CVR cache. An explicitly configured sequence
identity layout preserves existing client/sequence behavior without migrating application tables.

Pull authorization, rows, versions, receipts, and acknowledgement state come from one consistent snapshot. Only
the originating client can use a CVR. Missing or expired views cause resets. Receipt replay is governed by the last
sequence in the client's supplied CVR. Equal row versions must represent equal serialized values.

Applications own schema negotiation, validation, domain authorization, shared-resource lock order, and side effects.
The package must not import an application domain, web framework, or authentication library. Pokes are hints and
cannot be required for eventual recovery. Keep Cloudflare and test-host dependencies in their explicit entry points.

## Checks

Run the real Postgres integration suite for changes to transaction or view behavior. Keep checks for duplicates,
gaps, committed prefixes, rollback, UUID binding, ownership, reset, and consistent snapshots.
