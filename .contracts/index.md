# Isocache Engine contracts

- [Operation transactions](001-synchronization/CONTRACT.md): identity, terminal outcomes, rollback and committed prefixes.
- [Consistent client views](002-views/CONTRACT.md): authorized snapshots, CVRs, reset and bounded cleanup.
- [Shared ownership](003-code-ownership-and-boundaries/CONTRACT.md): domain adapters and explicit runtime entry points.
- [Compiler strictness](004-code-typescript-compiler-strictness/CONTRACT.md): strict source, scripts and tests.
- [Contract maintenance](005-contract-maintenance/CONTRACT.md): scoped requirements and update provenance.

Run `mise run check:contracts` for document validation and the root `mise run check` for required code checks.
Shared contracts are pinned in [`.tenet.lock`](../.tenet.lock). Their `Local adaptations` sections define repository
scope; [the adoption record](../.agents/guidance-adoption.md) explains the reviewed source and retained differences.
Model assessments are separate from deterministic checks and must report provider failures or incomplete scope.
