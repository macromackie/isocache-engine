import type { PoolClient } from "pg";
import type { Outcome, Updates, VersionedRow } from "../protocol.js";

export type OperationContext = {
  principalID: string;
  clientID: string;
  sequence: number;
  operationID: string | undefined;
};

export type ViewContext = { principalID: string; clientID: string; schema: number };

export type DecodedOperation<Command> = {
  id?: string;
  sequence: number;
  name?: string;
  args?: unknown;
  command: Command;
};

type ExtensionFields<Extension> = [Extension] extends [undefined]
  ? { extension?: Extension }
  : { extension: Extension };

export type ApplicationView<Entity, Extension = undefined> = {
  rows: readonly VersionedRow<Entity>[];
} & ExtensionFields<Extension>;

export type PullResult<Entity, Extension = undefined> = Updates<Entity> & {
  extension: ApplicationView<Entity, Extension>["extension"];
};

export type ApplicationSync<Command, Entity, Extension = undefined> = {
  authorize?(tx: PoolClient, context: { principalID: string }): Promise<void>;
  apply(tx: PoolClient, context: OperationContext, command: Command): Promise<Outcome>;
  readView(tx: PoolClient, context: ViewContext): Promise<ApplicationView<Entity, Extension>>;
};

export type PushInput<Command> = {
  principalID: string;
  request: {
    version: 1 | 2;
    clientID: string;
    operations: readonly DecodedOperation<Command>[];
  };
};

export type PullInput = {
  principalID: string;
  request: {
    version: 1 | 2;
    clientID: string;
    cookie: string | null;
    schema?: number | undefined;
  };
};
