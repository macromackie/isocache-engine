---
okf_version: "0.2"
---

# Isocache Engine context

- [CVR design](cvr-design.md): protocol inspiration and the boundary between the engine and application policy.

Adopted invariants live in [.contracts](../.contracts/index.md). Setup and the runnable local example live in the README.

Operation transactions and consistent views have separate [contracts](../.contracts/index.md). The public adapter
accepts domain work in the current transaction; its metadata store and migration runner remain engine-owned.
[Guidance adoption](../.agents/guidance-adoption.md) records the reviewed release and local adaptations.
