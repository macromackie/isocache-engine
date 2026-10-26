---
type: Concept
title: CVR design
description: Use authorized row-version views with durable ordered operations and app-owned domain policy.
generated:
  - date: 2026-10-25
    by: Codex
sources:
  - id: replicache
    url: https://doc.replicache.dev/strategies/row-version
  - id: zero
    url: https://zero.rocicorp.dev/docs/self-host
  - id: linear
    url: https://linear.app/now/rebuilding-delta-sync-read-path
---

# CVR design

Isocache uses the Replicache row-version pattern: an application computes an authorized view and the engine
compares its key/version map with the client's previous CVR. Losing that cache causes a reset, while durable
client sequences and receipts still protect repeated operations.[^replicache]

The application owns domain tables, projected values, access checks, and conflict policy. Isocache owns ordered
operation transactions and consistent view delivery. A shared scorecard can therefore use conditional per-cell
writes without making the engine understand golf or inventing a general conflict-resolution language.

Zero's query-maintenance/replication infrastructure and Linear's ordered application change log offer useful
ideas about scoped data and reconnect catch-up. This implementation computes and diffs app-defined views on
pull. It does not include those systems' query engine, changefeed, or serving index.[^zero][^linear]

The [Worker example](../examples/worker.ts) uses the same Postgres engine under Wrangler and celld. Runtime
selection and connection settings belong at composition. Pokes are expendable hints; the pull is authoritative.
Measure projected row count, query time, CVR size, and reset cost before adding a different delivery index.

The Postgres implementation separates operation ordering, view construction and metadata persistence under
`src/postgres/`. The public entry point retains explicit exports. Runtime validation decodes database rows at their
owner before orchestration uses them. Accepted, rejected and applied-with-notice outcomes have distinct types; the
latter two require a code and message. These internal API choices preserve the CVR and durable receipt model above.

[^replicache]: Replicache, [Row Version Strategy](https://doc.replicache.dev/strategies/row-version), accessed October 25, 2026.

[^zero]: Zero, [Self-hosting](https://zero.rocicorp.dev/docs/self-host), accessed October 25, 2026.

[^linear]: Linear, [Rebuilding the delta sync read path](https://linear.app/now/rebuilding-delta-sync-read-path), accessed October 25, 2026.
