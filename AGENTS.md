# Isocache Engine

Read [.contracts](.contracts/index.md) before changing sync behavior.
Keep domain models, authentication, and authorization in consuming applications. Preserve exported wire shapes.
Use the pinned tools and lockfile. Run `mise run check` before handing off changes.
Tests own their disposable database containers and must remove them. Never use an existing database for tests.

Shared contract revisions and local adaptations are recorded in
[guidance adoption](.agents/guidance-adoption.md) and `.tenet.lock`. Read a changed contract with its owning code;
syntax validation alone does not establish behavior. Keep operational commands in the README and design evidence
in `.context`.
