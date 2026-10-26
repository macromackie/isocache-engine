export type Mutation<Arguments = unknown> = {
  id: string;
  sequence: number;
  name: string;
  args: Arguments;
};

export type PushRequest<Arguments = unknown> = {
  version: 2;
  clientID: string;
  operations: Mutation<Arguments>[];
};

export type PullRequest = {
  version: 2;
  clientID: string;
  cookie: string | null;
  schema?: number;
};

export type VersionedRow<Entity> = { key: string; version: string; value: Entity };
export type TerminalStatus = Outcome["status"];
export type Receipt = {
  sequence: number;
  error: string | null;
  id?: string;
  code?: string;
  status?: Exclude<TerminalStatus, "accepted">;
};

export type Updates<Entity> = {
  version: 2;
  cookie: string;
  order: number;
  clear: boolean;
  put: VersionedRow<Entity>[];
  del: string[];
  lastSequence: number;
  rejections: Receipt[];
};

export type Outcome =
  | { status: "accepted"; recipients?: readonly string[] }
  | { status: "rejected"; code: string; message: string; recipients?: readonly string[] }
  | { status: "appliedWithNotice"; code: string; message: string; recipients?: readonly string[] };

export function diff<Entity>(
  rows: readonly VersionedRow<Entity>[],
  before: Record<string, string>,
) {
  const versions = new Map<string, string>();
  const put: VersionedRow<Entity>[] = [];
  for (const row of rows) {
    if (versions.has(row.key)) throw new Error(`Duplicate view key: ${row.key}`);
    versions.set(row.key, row.version);
    if (!Object.hasOwn(before, row.key) || before[row.key] !== row.version) put.push(row);
  }
  const del = Object.keys(before).filter((key) => !versions.has(key));
  return { versions: Object.fromEntries(versions), put, del };
}
