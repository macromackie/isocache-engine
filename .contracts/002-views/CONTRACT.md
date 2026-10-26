---
name: views
message: Build authorized rows and client-view records from one consistent snapshot and reset only disposable views.
paths: ["src/postgres/**/*.ts", "src/protocol.ts", "src/cloudflare.ts", "test/**/*.ts"]
---

# Consistent client views

## Rules

Read authorization, serialized rows, versions, receipts and acknowledgement state from one consistent database
snapshot. Equal row versions represent equal serialized values. Domain projection changes must therefore change
versions, including changes to joined profile or membership data.

Permit only the originating client to reuse a CVR. Missing or expired views cause a reset. Replay terminal receipts
from the last sequence in the supplied view. Bound CVR cleanup and keep permanent operation identity outside that
cache. A view reset never deletes application data or durable terminal receipts.

Keep schema negotiation and authorized row queries in application store adapters. Keep Cloudflare transport and
disposable test-host dependencies in explicit package entry points. A poke requests a pull and is never necessary
for eventual recovery or a substitute for authorization.

## Checks

Run the Postgres checks for ownership, resets, incremental diffs, receipt replay and consistent snapshots. Change a
joined value and confirm the projection and version change together. Confirm view cleanup leaves operation identity
available for retry. Inspect declared exports so runtime consumers do not pull in test-host dependencies.
