import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { peers } from '../src/claude';

test('session hooks own one receiver per task, restore it after resume and clean up on Desktop disconnect', async () => {
  const root = mkdtempSync('/tmp/uds-life-');
  const codexHome = join(root, 'codex');
  const configDir = join(root, 'claude');
  const ipcDir = join(codexHome, 'ipc');
  mkdirSync(ipcDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'cc-socks'), { mode: 0o755 });
  const clients = new Set<net.Socket>();
  let pauseHandshake = false;
  let releaseHandshake: (() => void) | undefined;
  const handshakeSeen = Promise.withResolvers<void>();
  const desktop = net.createServer(socket => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      while (buffer.length >= 4) {
      const length = buffer.readUInt32LE();
      if (buffer.length < length + 4) return;
      const request = JSON.parse(buffer.subarray(4, length + 4).toString());
      buffer = buffer.subarray(length + 4);
      if (request.method === 'thread-stream-following-changed' && !request.params.following) continue;
      const body = Buffer.from(JSON.stringify(request.method === 'thread-stream-following-changed'
        ? { type: 'broadcast', sourceClientId: 'owner', method: 'thread-stream-state-changed', version: 11,
          params: { conversationId: request.params.conversationId, change: { type: 'snapshot',
            conversationState: { cwd: root, threadRuntimeStatus: { type: 'idle' }, currentPermissions: { approvalPolicy: 'on-request' } } } } }
        : { type: 'response', requestId: request.requestId, handledByClientId: 'owner', resultType: 'success',
          result: request.method === 'initialize' ? { clientId: randomUUID() } : { supportsUntrustedAppInput: true } }));
      const frame = Buffer.alloc(body.length + 4);
      frame.writeUInt32LE(body.length);
      body.copy(frame, 4);
      if (pauseHandshake && request.method === 'initialize') {
        releaseHandshake = () => socket.write(frame);
        handshakeSeen.resolve();
      } else socket.write(frame);
      }
    });
  });
  const ipcPath = join(ipcDir, 'ipc.sock');
  desktop.listen(ipcPath);
  await once(desktop, 'listening');
  chmodSync(ipcPath, 0o600);
  const threadId = randomUUID();
  const otherId = randomUUID();
  const hook = async (id: string, hook_event_name: 'SessionStart' | 'SessionEnd', expectedExit = 0) => {
    const entrypoint = process.env.UDS_HOOK_TEST_ENTRYPOINT ?? join(import.meta.dir, '../src/hook.ts');
    const child = Bun.spawn([process.execPath, entrypoint], {
      env: { ...process.env, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_TMPDIR: root },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    child.stdin.write(JSON.stringify({ session_id: id, cwd: root, hook_event_name }));
    child.stdin.end();
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (expectedExit === 0) expect({ code, out, err }).toEqual({ code: 0, out: '', err: '' });
    else {
      expect(code).toBe(expectedExit);
      expect(err).toContain('Session ended or was replaced');
    }
  };
  const live = (id: string) => peers(configDir).filter(peer => peer.sessionId === id);
  try {
    await hook(threadId, 'SessionStart');
    const first = live(threadId)[0];
    expect(first).toBeDefined();
    expect(first?.cwd).toBe(root);
    expect(first?.messagingSocketPath).toStartWith(`/tmp/cc-socks-${process.getuid?.()}/`);
    await hook(threadId, 'SessionStart');
    expect(live(threadId)).toHaveLength(1);
    expect(live(threadId)[0]?.pid).toBe(first?.pid);
    await hook(otherId, 'SessionStart');
    expect(live(otherId)).toHaveLength(1);
    await hook(threadId, 'SessionEnd');
    expect(live(threadId)).toHaveLength(0);
    expect(existsSync(first!.messagingSocketPath)).toBe(false);
    expect(live(otherId)).toHaveLength(1);
    await hook(threadId, 'SessionStart');
    const crashed = live(threadId)[0];
    if (!crashed) throw new Error('Missing receiver before crash test');
    process.kill(crashed.pid, 'SIGKILL');
    const crashDeadline = Date.now() + 2000;
    while (live(threadId).length > 0 && Date.now() < crashDeadline) await Bun.sleep(10);
    await hook(threadId, 'SessionStart');
    const resumed = live(threadId)[0];
    expect(resumed?.sessionId).toBe(threadId);
    expect(resumed?.pid).not.toBe(crashed.pid);
    for (const socket of clients) socket.destroy();
    const deadline = Date.now() + 3000;
    while (peers(configDir).length > 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(peers(configDir)).toHaveLength(0);
    expect(existsSync(resumed!.messagingSocketPath)).toBe(false);

    pauseHandshake = true;
    const racingId = randomUUID();
    const opening = hook(racingId, 'SessionStart', 1);
    await handshakeSeen.promise;
    await hook(racingId, 'SessionEnd');
    if (!releaseHandshake) throw new Error('Missing startup barrier');
    releaseHandshake();
    await opening;
    expect(live(racingId)).toHaveLength(0);
  } finally {
    for (const peer of peers(configDir)) process.kill(peer.pid, 'SIGTERM');
    for (const socket of clients) socket.destroy();
    await new Promise<void>(resolve => desktop.close(() => resolve()));
    rmSync(root, { recursive: true });
  }
}, 15000);
