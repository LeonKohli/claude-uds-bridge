import net from "node:net";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const requestSchema = z.object({ type: z.string(), requestId: z.string().optional(), method: z.string(), params: z.unknown() });

export async function receiver(state: 'active' | 'idle', dropAcknowledgement = false, endBeforeSteer = false, root = mkdtempSync('/tmp/desktop-test-')) {
  mkdirSync(join(root, 'ipc'), { mode: 0o700 });
  const path = join(root, 'ipc', 'ipc.sock');
  const threadId = randomUUID();
  const turnId = randomUUID();
  const submissions: { method: string; params: unknown }[] = [];
  let permissions: unknown = { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } };
  let history: Record<string, unknown> = { turns: [], turnHistory: { kind: 'legacy' } };
  const clients = new Set<net.Socket>();
  const announce = new Set<() => void>();
  const server = net.createServer(socket => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    const write = (packet: unknown) => {
      const body = Buffer.from(JSON.stringify(packet));
      const framed = Buffer.alloc(4 + body.length);
      framed.writeUInt32LE(body.length);
      body.copy(framed, 4);
      socket.write(framed);
    };
    announce.add(() => write({ type: 'broadcast', sourceClientId: 'owner', method: 'thread-stream-state-changed', version: 11,
      params: { conversationId: threadId, change: { type: 'patches', patches: [
        { op: 'replace', path: ['threadRuntimeStatus'], value: { type: state } },
        { op: 'replace', path: ['currentPermissions'], value: permissions },
      ] } } }));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
        const size = buffer.readUInt32LE();
        const request = requestSchema.parse(JSON.parse(buffer.subarray(4, 4 + size).toString('utf8')));
        buffer = buffer.subarray(4 + size);
        const reply = (result: unknown) => write({ type: 'response', requestId: request.requestId,
          handledByClientId: 'owner', resultType: 'success', result });
        if (request.method === 'initialize') reply({ clientId: 'test-client' });
        else if (request.method === 'thread-owner-discovery') reply({ supportsUntrustedAppInput: true });
        else if (request.method === 'thread-stream-following-changed') {
          if (!z.object({ following: z.boolean() }).parse(request.params).following) continue;
          write({ type: 'broadcast', sourceClientId: 'owner', method: 'thread-stream-state-changed', version: 11,
            params: { conversationId: threadId, change: { type: 'snapshot',
              conversationState: { cwd: root, threadRuntimeStatus: { type: state }, currentPermissions: permissions, ...history } } } });
        } else {
          if (request.method === 'thread-follower-steer-turn' && endBeforeSteer) {
            state = 'idle';
            write({ type: 'response', requestId: request.requestId, resultType: 'error',
              error: `Cannot steer conversation ${threadId} because its active turn already ended` });
            continue;
          }
          submissions.push({ method: request.method, params: request.params });
          if (dropAcknowledgement) socket.destroy();
          else reply({ result: state === 'active' ? { turnId } : { turn: { id: turnId } } });
        }
      }
    });
  });
  server.listen(path);
  await once(server, 'listening');
  chmodSync(path, 0o600);
  return { path, threadId, turnId, submissions,
    setHistory(value: Record<string, unknown>) { history = { turns: [], turnHistory: { kind: 'legacy' }, ...value }; },
    setPermissions(value: unknown) { permissions = value; for (const send of announce) send(); },
    setState(value: 'idle' | 'active') { state = value; for (const send of announce) send(); }, close: async () => {
    for (const socket of clients) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true });
  } };
}
