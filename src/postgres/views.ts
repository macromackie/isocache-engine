import type { Pool } from "pg";
import { diff } from "../protocol.js";
import type { ApplicationSync, PullInput, PullResult } from "./types.js";
import type { MetadataStore } from "./metadata-store.js";
import { identifier } from "./validation.js";
import { transaction } from "./transaction.js";

function extensionOf<View extends { extension?: unknown }>(view: View): View["extension"] {
  return view.extension;
}

export async function pullView<Command, Entity, Extension>(
  pool: Pool,
  metadata: MetadataStore,
  application: ApplicationSync<Command, Entity, Extension>,
  { principalID, request }: PullInput,
): Promise<PullResult<Entity, Extension>> {
  const clientID = identifier(request.clientID);
  const requestedCookie = request.cookie === null ? null : identifier(request.cookie);
  return transaction(pool, async (tx) => {
    await application.authorize?.(tx, { principalID });
    const lastSequence = await metadata.lockClient(tx, principalID, clientID, request.version);
    const previous = await metadata.readView(tx, clientID, requestedCookie);
    const view = await application.readView(tx, {
      principalID,
      clientID,
      schema: request.schema ?? 0,
    });
    const { versions, put, del } = diff(view.rows, previous?.versions ?? {});
    const unchanged =
      previous &&
      requestedCookie !== null &&
      put.length === 0 &&
      del.length === 0 &&
      (request.version === 1 || previous.lastSequence === lastSequence);
    let cookie: string;
    let order: number;
    if (unchanged) {
      cookie = requestedCookie;
      order = previous.order;
    } else {
      cookie = crypto.randomUUID();
      order = await metadata.saveView(tx, clientID, cookie, versions, lastSequence);
    }
    const after = request.version === 2 && previous ? previous.lastSequence : 0;
    const rejections = await metadata.rejections(tx, clientID, after);
    await metadata.expireClientViews(tx, clientID);
    return {
      version: 2 as const,
      cookie,
      order,
      clear: !previous,
      put,
      del,
      lastSequence,
      rejections,
      extension: extensionOf(view),
    };
  });
}
