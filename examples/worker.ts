import { Pool } from 'pg';
import { createPostgresSync, SyncError } from '../src/postgres.js';
import type { Mutation } from '../src/protocol.js';

type Command = { key: string; value: string };
type Bindings = { DATABASE_URL: string; DEMO_PRINCIPAL: string; BUILD_ID?: string };

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);
    if (!['localhost', '127.0.0.1'].includes(url.hostname))
      return new Response('Local example only.', { status: 403 });
    if (url.pathname === '/health')
      return Response.json({
        status: 'ok',
        app: 'isocache-example',
        environment: 'local',
        protocol: 2,
        build: env.BUILD_ID ?? 'example',
      });
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 3,
      connectionTimeoutMillis: 2000,
    });
    const engine = createPostgresSync<Command, Command>({
      pool,
      application: {
        async apply(tx, context, command) {
          await tx.query(
            'INSERT INTO notes(owner_id,key,value) VALUES($1,$2,$3) ON CONFLICT(owner_id,key) DO UPDATE SET value=$3, version=notes.version+1',
            [context.principalID, command.key, command.value],
          );
          return { status: 'accepted' };
        },
        async readView(tx, context) {
          const rows = await tx.query(
            'SELECT key,value,version::text FROM notes WHERE owner_id=$1 ORDER BY key',
            [context.principalID],
          );
          return {
            rows: rows.rows.map(({ key, value, version }) => ({
              key,
              version,
              value: { key, value },
            })),
          };
        },
      },
    });
    try {
      if (request.method !== 'POST') return new Response('Not found.', { status: 404 });
      const body = (await request.json()) as Record<string, unknown>;
      if (body.version !== 2 || typeof body.clientID !== 'string')
        return new Response('Invalid envelope.', { status: 400 });
      if (url.pathname === '/push') {
        if (!Array.isArray(body.operations))
          return new Response('Invalid operations.', { status: 400 });
        const operations = body.operations.map((value: Mutation<Command>) => {
          if (
            !value ||
            value.name !== 'setNote' ||
            typeof value.args?.key !== 'string' ||
            typeof value.args?.value !== 'string'
          )
            throw new SyncError('Invalid command.', 400);
          return {
            id: value.id,
            sequence: value.sequence,
            name: value.name,
            args: value.args,
            command: value.args,
          };
        });
        await engine.push({
          principalID: env.DEMO_PRINCIPAL,
          request: { version: 2, clientID: body.clientID, operations },
        });
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/pull') {
        if (body.cookie !== null && typeof body.cookie !== 'string')
          return new Response('Invalid cookie.', { status: 400 });
        return Response.json(
          await engine.pull({
            principalID: env.DEMO_PRINCIPAL,
            request: { version: 2, clientID: body.clientID, cookie: body.cookie },
          }),
        );
      }
      return new Response('Not found.', { status: 404 });
    } catch (error) {
      if (error instanceof SyncError)
        return Response.json({ error: error.message }, { status: error.status });
      throw error;
    } finally {
      await pool.end();
    }
  },
};
