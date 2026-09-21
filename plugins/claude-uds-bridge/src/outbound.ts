import net from 'node:net';
import { once } from 'node:events';
import { chmodSync } from 'node:fs';
import { z } from 'zod';
import { checkSocket, findPeer, frameSchema, SendRefused, sendFrames, uuid, type Frame, type Peer } from './claude';

const requestSchema = z.union([z.object({ type: z.literal('refresh') }),
  z.object({ sessionId: uuid, socketPath: z.string(), procStart: z.string().nullable(), frames: z.array(frameSchema).min(1).max(200) })]);

function readLine(socket: net.Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('close', () => reject(new Error('Local sender disconnected; send outcome may be unknown')));
    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { reject(new Error('Local send request too large')); socket.destroy(); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try { resolve(JSON.parse(buffer.slice(0, end))); }
      catch { reject(new Error('Invalid local send request')); }
    });
  });
}

export async function outboundServer(path: string, configDir: string, address: string, canWrite: (frames: Frame[]) => boolean, onRequest: () => void) {
  const connections = new Set<net.Socket>();
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.setTimeout(15000, () => socket.destroy());
    void (async () => {
      try {
        const request = requestSchema.parse(await readLine(socket));
        if ('type' in request) {
          onRequest();
          socket.end(JSON.stringify({ refreshed: true }) + '\n');
          return;
        }
        if (request.frames.some(frame => frame.from !== address)) throw new Error('Wrong sending task');
        const peer = findPeer(configDir, request.sessionId);
        if (peer.messagingSocketPath !== request.socketPath || (peer.procStart ?? null) !== request.procStart) throw new Error('Target process changed');
        onRequest();
        const written = await sendFrames(configDir, peer, request.frames, { canWrite: () => canWrite(request.frames) });
        socket.end(JSON.stringify({ written }) + '\n');
      } catch (error) {
        if (!socket.destroyed) socket.end(JSON.stringify(error instanceof SendRefused
          ? { refused: error.message } : { error: 'Local send failed; inspect status before retrying' }) + '\n');
      }
    })();
  });
  const mask = process.umask(0o077);
  try { server.listen(path); await once(server, 'listening'); }
  finally { process.umask(mask); }
  chmodSync(path, 0o600);
  return () => new Promise<void>((resolve, reject) => {
    for (const socket of connections) socket.destroy();
    server.close(error => error ? reject(error) : resolve());
  });
}

export async function sendViaReceiver(path: string, peer: Peer, frames: unknown[]) {
  const result = z.union([z.object({ written: z.boolean() }), z.object({ refused: z.string() })]).parse(
    await requestReceiver(path, { sessionId: peer.sessionId, socketPath: peer.messagingSocketPath, procStart: peer.procStart ?? null, frames }));
  if ('refused' in result) throw new SendRefused(result.refused);
  return result.written;
}

export async function refreshReceiver(path: string) {
  z.object({ refreshed: z.literal(true) }).parse(await requestReceiver(path, { type: 'refresh' }));
}

async function requestReceiver(path: string, request: unknown) {
  checkSocket(path);
  const socket = net.createConnection(path);
  socket.setTimeout(15000, () => socket.destroy());
  const response = readLine(socket);
  try {
    await once(socket, 'connect', { signal: AbortSignal.timeout(5000) });
    socket.write(JSON.stringify(request) + '\n');
    return await response;
  } finally { socket.destroy(); void response.catch(() => {}); }
}
