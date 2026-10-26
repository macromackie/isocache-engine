import type { Pool } from "pg";
import type { ApplicationSync, PullInput, PushInput } from "./types.js";
import { createMetadataStore } from "./metadata-store.js";
import type { MetadataLayout } from "./metadata-store.js";
import { pushOperations } from "./operations.js";
import { pullView } from "./views.js";

export { migrateSync } from "./migrations.js";
export { SyncError, transaction } from "./transaction.js";
export type { MetadataLayout } from "./metadata-store.js";
export type {
  ApplicationSync,
  ApplicationView,
  DecodedOperation,
  OperationContext,
  PullResult,
  ViewContext,
} from "./types.js";

export function createPostgresSync<Command, Entity, Extension = undefined>({
  pool,
  application,
  metadata,
}: {
  pool: Pool;
  application: ApplicationSync<Command, Entity, Extension>;
  metadata?: MetadataLayout;
}) {
  const store = createMetadataStore(metadata);
  return {
    push: (input: PushInput<Command>) => pushOperations(pool, store, application, input),
    pull: (input: PullInput) => pullView(pool, store, application, input),
  };
}

export async function pruneViews(
  pool: Pool,
  { limit = 1000, metadata }: { limit?: number; metadata?: MetadataLayout } = {},
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
    throw new Error("Invalid view cleanup limit.");
  return createMetadataStore(metadata).pruneViews(pool, limit);
}
