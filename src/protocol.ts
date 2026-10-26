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
export type TerminalStatus = 'accepted' | 'rejected' | 'appliedWithNotice';
export type Receipt = {
  sequence: number;
  error: string | null;
  id?: string;
  code?: string;
  status?: Exclude<TerminalStatus, 'accepted'>;
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

export type Outcome = {
  status: TerminalStatus;
  code?: string;
  message?: string;
  recipients?: readonly string[];
};

export function diff<Entity>(
  rows: readonly VersionedRow<Entity>[],
  before: Record<string, string>,
) {
  const versions: Record<string, string> = Object.create(null);
  const put: VersionedRow<Entity>[] = [];
  for (const row of rows) {
    if (Object.hasOwn(versions, row.key)) throw new Error(`Duplicate view key: ${row.key}`);
    versions[row.key] = row.version;
    if (!Object.hasOwn(before, row.key) || before[row.key] !== row.version) put.push(row);
  }
  const del = Object.keys(before).filter((key) => !Object.hasOwn(versions, key));
  return { versions, put, del };
}
