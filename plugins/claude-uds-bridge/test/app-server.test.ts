import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppServer, withAppServer } from '../src/app-server';
import { peers } from '../src/claude';
import { appServer } from './app-server-fixture';
import { watchCodex } from '../src/codex';

test('a CLI session registers without desktop IPC and withdraws at SessionEnd', async () => {
  const server = await appServer();
  const configDir = join(server.root, 'claude');
  const hook = async (hook_event_name: 'SessionStart' | 'SessionEnd') => {
    const child = Bun.spawn([process.execPath, process.env.UDS_HOOK_TEST_ENTRYPOINT ?? join(import.meta.dir, '../src/hook.ts')],
      { env: { ...process.env, CODEX_HOME: server.root, CLAUDE_CONFIG_DIR: configDir }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    child.stdin.write(JSON.stringify({ session_id: server.threadId, cwd: server.root, hook_event_name }));
    child.stdin.end();
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, out, err }).toEqual({ code: 0, out: '', err: '' });
  };
  try {
    await hook('SessionStart');
    expect(peers(configDir).map(peer => peer.sessionId)).toEqual([server.threadId]);
    await hook('SessionEnd');
    expect(peers(configDir)).toEqual([]);
  } finally {
    for (const peer of peers(configDir)) process.kill(peer.pid, 'SIGTERM');
    await server.close();
  }
});

test('peer input has tool authority and an independent delivery ID in idle and active threads', async () => {
  const server = await appServer();
  try {
    for (const state of ['idle', 'active'] as const) {
      server.setState(state);
      const inputId = randomUUID();
      const result = await withAppServer(server.path, server.threadId, client => client.submit(inputId, 'peer update'));
      expect(result).toEqual({ status: 'accepted', turnId: server.turnId });
      expect(server.submissions.at(-1)?.params).toEqual({ threadId: server.threadId, input: [],
        toolOutput: { name: 'peer_message', namespace: 'claude_uds_bridge', output: JSON.stringify({ inputId, content: 'peer update' }) } });
    }
    server.loseAcknowledgement();
    await expect(withAppServer(server.path, server.threadId, client => client.submit(randomUUID(), 'uncertain update'))).rejects.toThrow();
    expect(server.submissions).toHaveLength(3);
  } finally { await server.close(); }
});

test('delivery refuses a thread unloaded after preflight without loading it again', async () => {
  const server = await appServer();
  try {
    server.unloadOnNextRead();
    await expect(withAppServer(server.path, server.threadId, client => client.submit(randomUUID(), 'late message')))
      .rejects.toThrow('Thread is not loaded');
    expect(server.submissions).toEqual([]);
  } finally { await server.close(); }
});

test('consumed peer inputs correlate across history pages and new user input resets the origin', async () => {
  const server = await appServer();
  const inputId = randomUUID();
  const nativeId = randomUUID();
  const userId = randomUUID();
  const peer = { type: 'functionCallOutput', id: nativeId, name: 'peer_message', namespace: 'claude_uds_bridge',
    output: JSON.stringify({ inputId, content: 'peer update' }) };
  const tail = Array.from({ length: 110 }, () => ({ type: 'agentMessage', id: randomUUID() }));
  try {
    server.setItems([peer, ...tail]);
    expect(await withAppServer(server.path, server.threadId, client => client.inputs([inputId])))
      .toEqual({ latest: { id: nativeId, clientId: inputId }, consumed: [{ id: nativeId, clientId: inputId }] });
    server.setItems([peer, ...tail, { type: 'userMessage', id: userId }]);
    const inputs = await withAppServer(server.path, server.threadId, client => client.inputs([inputId]));
    expect(inputs.latest).toEqual({ id: userId, clientId: null });
    expect(inputs.consumed).toContainEqual({ id: nativeId, clientId: inputId });
    server.setItems([peer, { type: 'functionCallOutput', id: userId, name: 'other_external_input', namespace: null, output: 'update' }]);
    expect((await withAppServer(server.path, server.threadId, client => client.inputs([inputId]))).latest)
      .toEqual({ id: userId, clientId: null });
  } finally { await server.close(); }
});

test('queued work prevents idle and the bridge leaves approval requests to the existing UI', async () => {
  const server = await appServer();
  const states: { status: string; mode: string }[] = [];
  const client = new AppServer(server.path, server.threadId);
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 1000;
    while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
    expect(predicate()).toBe(true);
  };
  try {
    await client.connect();
    server.setPermissions({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
    await client.runtime();
    await client.observe(state => states.push(state));
    expect(states.at(-1)).toEqual({ status: 'idle', mode: 'bypass' });
    server.setPermissions({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } });
    await until(() => states.at(-1)?.mode === 'prompting');
    server.setQueue([{ id: randomUUID() }]);
    server.requestApproval();
    await until(() => states.at(-1)?.status === 'busy');
    server.setPermissions({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
    await until(() => states.at(-1)?.mode === 'bypass');
    server.setQueue([]);
    await until(() => states.at(-1)?.status === 'idle');
    expect(server.responses).toEqual([]);
    expect(server.submissions).toEqual([]);
  } finally { client.close(); await server.close(); }
});

test('an observer disconnect suspends reception until fresh permissions are read', async () => {
  const server = await appServer();
  const states: { status: string; mode: string }[] = [];
  let disconnected = false;
  const stop = await watchCodex({ kind: 'app-server', path: server.path }, server.threadId,
    state => states.push(state), () => { disconnected = true; });
  try {
    server.disconnectClients();
    server.setPermissions({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
    const deadline = Date.now() + 2000;
    while (states.at(-1)?.mode !== 'bypass' && !disconnected && Date.now() < deadline) await Bun.sleep(5);
    expect(disconnected).toBe(false);
    expect(states).toContainEqual({ status: 'unknown', mode: 'unknown' });
    expect(states.at(-1)).toEqual({ status: 'idle', mode: 'bypass' });
    expect(server.submissions).toEqual([]);
  } finally { stop(); await server.close(); }
});
