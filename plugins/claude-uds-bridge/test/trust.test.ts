import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { peers, processStart, sendFrames } from '../src/claude';

// The local user is the trust boundary: a sender address is not an identity. These tests bend one
// property of an otherwise valid peer and expect discovery or sending to reject it.
async function fixture() {
  const root = mkdtempSync('/tmp/uds-trust-');
  const configDir = join(root, 'claude');
  const sessions = join(configDir, 'sessions');
  const directory = join(root, 's');
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  const socketPath = join(directory, `${process.pid}.sock`);
  const server = net.createServer(socket => socket.resume());
  server.listen(socketPath);
  await once(server, 'listening');
  chmodSync(socketPath, 0o600);
  const sessionId = randomUUID();
  const procStart = await processStart(process.pid);
  const write = (record: Record<string, unknown>, file = `${process.pid}.json`) =>
    writeFileSync(join(sessions, file), JSON.stringify({ pid: process.pid, sessionId, messagingSocketPath: socketPath,
      cwd: root, peerProtocol: 1, peerFeatures: [], procStart, ...record }), { mode: 0o600 });
  write({});
  const frame = { msgV: 1, type: 'user', msg_id: randomUUID(), from: 'uds:/dev/null',
    message: { role: 'user', content: 'trust probe' } };
  return { configDir, sessions, socketPath, sessionId, procStart, write, frame,
    peer: () => peers(configDir)[0],
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    } };
}

test('discovery drops a session record that disagrees with its own file name or socket', async () => {
  const f = await fixture();
  try {
    expect(f.peer()?.sessionId).toBe(f.sessionId);

    // A second file claiming this process would let one live session answer under two identities.
    f.write({}, '999999.json');
    expect(peers(f.configDir).map(peer => peer.sessionId)).toEqual([f.sessionId]);
    rmSync(join(f.sessions, '999999.json'));

    // The socket has to belong to the process named by the record, so a stale or borrowed
    // path cannot redirect messages to whoever listens there now.
    f.write({ messagingSocketPath: join(f.sessions, '..', 's', 'somebody-else.sock') });
    expect(peers(f.configDir)).toEqual([]);
  } finally { await f.close(); }
});

test('sending refuses a peer socket that other users can reach', async () => {
  const f = await fixture();
  try {
    const peer = f.peer();
    expect(peer).toBeDefined();
    expect(await sendFrames(f.configDir, peer!, [f.frame])).toBe(true);

    chmodSync(f.socketPath, 0o660);
    await expect(sendFrames(f.configDir, peer!, [f.frame])).rejects.toThrow('Invalid peer socket');
  } finally { await f.close(); }
});

test('sending refuses a peer whose process identity no longer matches', async () => {
  const f = await fixture();
  try {
    // A PID is reused after a session dies, so the recorded start time is what separates
    // the peer that registered from whatever process now holds its number.
    f.write({ procStart: 'Thu Jan  1 00:00:00 2026' });
    const peer = f.peer();
    expect(peer?.procStart).toBe('Thu Jan  1 00:00:00 2026');
    await expect(sendFrames(f.configDir, peer!, [f.frame])).rejects.toThrow('Peer process identity changed');
  } finally { await f.close(); }
});
