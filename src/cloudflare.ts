import { DurableObject } from 'cloudflare:workers';

export class PokeHub extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send('poke');
      } catch {
        // A disconnected peer catches up on its next pull.
      }
    }
    return new Response(null, { status: 204 });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (message === 'ping') socket.send('pong');
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string) {
    try {
      socket.close(code, reason);
    } catch {
      // The runtime may already have answered the close.
    }
  }
}

export type PokeTransport = {
  poke(principalIDs: Iterable<string>): Promise<void>;
  connect(principalID: string, request: Request): Promise<Response>;
};

export function pokeTransport(namespace: DurableObjectNamespace): PokeTransport {
  const hub = (principalID: string) => namespace.get(namespace.idFromName(principalID));
  return {
    async poke(principalIDs) {
      await Promise.all(
        [...new Set(principalIDs)].map((id) =>
          hub(id).fetch('https://poke-hub/poke', { method: 'POST' }),
        ),
      );
    },
    connect: (principalID, request) => hub(principalID).fetch(request),
  };
}
