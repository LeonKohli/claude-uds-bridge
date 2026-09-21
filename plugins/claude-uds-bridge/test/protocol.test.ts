import { test, expect } from 'bun:test';
import { mkdirSync, chmodSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CancelledNotificationSchema, ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Bridge } from '../src/bridge';
import { findPeer, frameSchema, hopChain, maxLineLength, peers, sendFrames, sessionName, userFrame } from '../src/claude';
import { receiver } from './desktop-fixture';

async function fixture() {
  const root = mkdtempSync('/tmp/uds-protocol-');
  const desktop = await receiver('idle', false, false, root);
  const configDir = join(root, 'claude');
  const stateDir = join(root, 'plugin-state', 'claude-uds-bridge');
  const directory = join(root, 's');
  mkdirSync(join(configDir, 'sessions'), { recursive: true, mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  const peerId = randomUUID();
  const peerPath = join(directory, `${process.ppid}.sock`);
  const frames: z.infer<typeof frameSchema>[] = [];
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        frames.push(frameSchema.parse(JSON.parse(buffer.slice(0, end))));
        buffer = buffer.slice(end + 1);
      }
    });
  });
  server.listen(peerPath);
  await once(server, 'listening');
  chmodSync(peerPath, 0o600);
  writeFileSync(join(configDir, 'sessions', `${process.ppid}.json`), JSON.stringify({
    pid: process.ppid, sessionId: peerId, messagingSocketPath: peerPath, cwd: root, peerProtocol: 1, peerFeatures: ['notify_idle'],
    startedAt: 1700000000000,
  }));
  const bridge = new Bridge(desktop.threadId, configDir, stateDir, desktop.path);
  await bridge.start(directory, root, bridge.beginSession());
  bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
  const db = new Database(join(stateDir, `${desktop.threadId}.sqlite`));
  const submittedInputId = (index = 0) => {
    const params = z.object({ clientUserMessageId: z.string().optional(),
      turnStart: z.object({ request: z.object({ clientUserMessageId: z.string() }) }).optional() }).parse(desktop.submissions[index]?.params);
    return z.string().parse(params.clientUserMessageId ?? params.turnStart?.request.clientUserMessageId);
  };
  const transmit = async (frame: Record<string, unknown>) => {
    const path = bridge.status().replyAddress?.slice(4);
    if (!path) throw new Error('No receiver');
    const socket = net.createConnection(path);
    await once(socket, 'connect');
    socket.end(JSON.stringify({ msgV: 1, from: `uds:${peerPath}`, ...frame }) + '\n');
    await once(socket, 'close');
  };
  return { bridge, desktop, db, peerId, peerPath, frames, root, configDir, transmit, submittedInputId,
    async message(mode?: string, text: string = randomUUID()) {
      const id = randomUUID();
      await transmit({ type: 'user', msg_id: id, session_id: desktop.threadId,
        message: { role: 'user', content: mode === undefined ? text : `<cross-session-message from-mode="${mode}">${text}</cross-session-message>` } });
      return id;
    },
    async close() { await bridge.close(); db.close(); await new Promise<void>(resolve => server.close(() => resolve())); await desktop.close(); },
  };
}

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

test('MCP sends and receives a peer reply with a large task history', async () => {
  const f = await fixture();
  const client = new Client({ name: 'large-history-test', version: '1.0.0' });
  try {
    f.desktop.setHistory({ turns: [{ items: [
      { type: 'agentMessage', id: randomUUID(), text: 'x'.repeat(17 * 1024 * 1024) },
      { type: 'userMessage', id: randomUUID(), clientId: null },
    ] }] });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [process.env.UDS_MCP_TEST_ENTRYPOINT ?? join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    const sent = await client.callTool({ name: 'send_message', arguments: { sessionId: f.peerId, text: 'large history ping' },
      _meta: { threadId: f.desktop.threadId } });
    expect(sent.isError).not.toBe(true);
    expect(f.frames.some(frame => frame.type === 'user' && frame.message.content.includes('large history ping'))).toBe(true);
    const id = await f.message('prompting', 'large history pong');
    await until(() => f.bridge.status().messages.some(row => row.id === id && row.status === 'started'));
    expect(f.desktop.submissions).toHaveLength(1);
    expect(JSON.stringify(f.desktop.submissions[0]?.params)).toContain('large history pong');
  } finally { await client.close(); await f.close(); }
});

test('outbound hops follow the last committed peer input and reset at a real user input', async () => {
  const f = await fixture();
  const token = 'a'.repeat(24);
  const id = randomUUID();
  const nativeId = randomUUID();
  const user = { type: 'userMessage', id: randomUUID(), clientId: null };
  try {
    await f.transmit({ type: 'user', msg_id: id, message: { role: 'user', content:
      `<cross-session-message hop-chain="${token}" from-mode="prompting">relay test</cross-session-message>` } });
    await until(() => f.bridge.status().messages.some(row => row.id === id && row.status === 'started'));
    const steering = { type: 'steeringUserMessage', id, clientUserMessageId: f.submittedInputId(), serverUserMessageId: null, status: 'accepted' };
    f.desktop.setHistory({ turns: [{ items: [user, steering] }] });
    await f.bridge.sendMessage(f.peerId, 'before consumption');
    const outgoing = () => f.frames.filter(frame => frame.type === 'user').map(frame => hopChain(frame.message.content));
    expect(outgoing().at(-1)).toHaveLength(1);
    f.desktop.setHistory({ turns: [{ items: [user, { ...steering, serverUserMessageId: nativeId }, { type: 'steered', id: nativeId }] }] });
    await f.bridge.sendMessage(f.peerId, 'after consumption');
    expect(outgoing().at(-1)).toEqual([token, outgoing()[0]![0]!]);
    // Resumed native history can lose client IDs; the observed server ID keeps the association.
    f.desktop.setHistory({ turns: [{ items: [{ type: 'userMessage', id: nativeId, clientId: null }] }] });
    await f.bridge.sendMessage(f.peerId, 'after resume');
    expect(outgoing().at(-1)).toEqual([token, outgoing()[0]![0]!]);
    f.desktop.setHistory({ turns: [{ items: [{ type: 'userMessage', id: nativeId, clientId: null }, user] }] });
    await f.bridge.sendMessage(f.peerId, 'new user request');
    expect(outgoing().at(-1)).toHaveLength(1);
    f.desktop.setHistory({ turns: [], turnHistory: { kind: 'unsupported' } });
    await expect(f.bridge.sendMessage(f.peerId, 'unknown origin')).rejects.toThrow('input origin');
    expect(outgoing()).toHaveLength(4);
  } finally { await f.close(); }
});

test('50 unread accepted messages are separate from held capacity and free a slot only on consumption', async () => {
  const f = await fixture();
  const ids = Array.from({ length: 50 }, () => randomUUID());
  try {
    f.db.transaction(() => {
      for (const id of ids) f.db.run("INSERT INTO messages (id,peer_id,direction,text,status,awaiting_input,desktop_input_id) VALUES (?,?,'in',?,'steered',1,?)", [id, f.peerId, id, id]);
    })();
    const overflow = await f.message('prompting');
    await until(() => f.bridge.status().messages.some(row => row.id === overflow && row.drop_reason === 'queue-full'));
    expect(f.desktop.submissions).toHaveLength(0);
    expect(f.bridge.status().unreadCount).toBe(50);
    const steering = { type: 'steeringUserMessage', id: ids[0], clientUserMessageId: ids[0], status: 'accepted', serverUserMessageId: null };
    f.desktop.setHistory({ turns: [{ items: [steering] }] });
    const stillFull = await f.message('prompting');
    await until(() => f.bridge.status().messages.some(row => row.id === stillFull && row.drop_reason === 'queue-full'));
    expect(f.desktop.submissions).toHaveLength(0);
    const serverId = randomUUID();
    f.desktop.setHistory({ turns: [{ items: [{ ...steering, serverUserMessageId: serverId }, { type: 'steered', id: serverId }] }] });
    const next = await f.message('prompting');
    await until(() => f.bridge.status().messages.some(row => row.id === next && row.status === 'started'));
    expect(f.desktop.submissions).toHaveLength(1);
    expect(f.bridge.status().unreadCount).toBe(50);
  } finally { await f.close(); }
});

test('idle stays pending while an accepted peer input has not been consumed', async () => {
  const f = await fixture();
  try {
    const id = await f.message('prompting');
    await until(() => f.bridge.status().messages.some(row => row.id === id && row.status === 'started'));
    const subscription = randomUUID();
    await f.transmit({ type: 'control', action: 'notify_when_idle', msg_id: subscription, from_mode: 'prompting' });
    await until(() => f.bridge.status().idleRequests.some(row => row.id === subscription));
    const notices = () => f.frames.filter(frame => frame.type === 'control' && frame.action === 'peer_idle_notice' && frame.orig_msg_id === subscription);
    await Bun.sleep(30);
    expect(notices()).toHaveLength(0);
    f.desktop.setHistory({ turns: [{ items: [{ type: 'userMessage', id: randomUUID(), clientId: f.submittedInputId() }] }] });
    f.bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
    await until(() => notices().length === 1);
    expect(f.bridge.status().unreadCount).toBe(0);
  } finally { await f.close(); }
});

test('a peer cannot claim an existing user input by choosing its client ID as msg_id', async () => {
  const f = await fixture();
  const id = randomUUID();
  try {
    f.desktop.setHistory({ turns: [{ items: [{ type: 'userMessage', id: randomUUID(), clientId: id }] }] });
    await f.transmit({ type: 'user', msg_id: id, message: { role: 'user', content:
      `<cross-session-message hop-chain="${'b'.repeat(24)}" from-mode="prompting">collision test</cross-session-message>` } });
    await until(() => f.bridge.status().messages.some(row => row.id === id && row.status === 'started'));
    await f.bridge.sendMessage(f.peerId, 'still the real user input');
    const frame = f.frames.find(frame => frame.type === 'user');
    expect(frame?.type === 'user' && hopChain(frame.message.content)).toHaveLength(1);
    expect(f.bridge.status().unreadCount).toBe(1);
  } finally { await f.close(); }
});

test('mode changes recheck held input without extending deadlines; explicit hold requires a policy change', async () => {
  const f = await fixture();
  try {
    const id = await f.message('bypass');
    await until(() => f.bridge.status().heldCount === 1);
    const deadline = f.bridge.held()[0]?.expires_at;
    f.bridge.updateRuntime({ status: 'busy', mode: 'unknown' });
    await Bun.sleep(30);
    expect(f.bridge.held()[0]?.expires_at).toBe(deadline);
    f.bridge.updateRuntime({ status: 'busy', mode: 'bypass' });
    await until(() => f.desktop.submissions.length === 1);
    expect(f.bridge.status().messages.find(row => row.id === id)?.status).toBe('started');
    await f.bridge.setPolicy('hold');
    const explicit = await f.message('prompting');
    await until(() => f.bridge.status().heldCount === 1);
    f.bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
    await expect(f.bridge.resolveHeld(explicit, 'approve')).rejects.toThrow('explicit hold');
    expect(f.desktop.submissions).toHaveLength(1);
    await f.bridge.setPolicy('accept');
    expect(f.desktop.submissions).toHaveLength(2);
  } finally { await f.close(); }
});

test('dialog expiry accepts the documented values; never and explicit hold keep no deadline', async () => {
  const f = await fixture();
  try {
    const id = await f.message('bypass');
    await until(() => f.bridge.status().heldCount === 1);
    for (const [expiry, milliseconds] of [['60s', 60000], ['5m', 300000], ['10m', 600000]] as const) {
      await f.bridge.setExpiry(expiry);
      const remaining = (f.bridge.held()[0]?.expires_at ?? 0) - Date.now();
      expect(remaining).toBeGreaterThan(milliseconds - 1000);
      expect(remaining).toBeLessThanOrEqual(milliseconds);
    }
    await f.bridge.setExpiry('never');
    expect(f.bridge.held()[0]?.expires_at).toBeNull();
    f.bridge.updateRuntime({ status: 'busy', mode: 'unknown' });
    await Bun.sleep(20);
    expect(f.bridge.held()[0]?.expires_at).toBeNull();
    await f.bridge.setPolicy('hold');
    await f.bridge.setExpiry('60s');
    expect(f.bridge.held()[0]?.expires_at).toBeNull();
    expect(f.bridge.status().messages.find(row => row.id === id)?.status).toBe('held');
  } finally { await f.close(); }
});

test('held capacity drops the oldest item separately from the delivery guard', async () => {
  const f = await fixture();
  try {
    await f.bridge.setPolicy('hold');
    const ids = Array.from({ length: 100 }, () => randomUUID());
    f.db.transaction(() => {
      for (const id of ids) f.db.run("INSERT INTO messages (id,peer_id,direction,text,status,peer_address,kind,created_at) VALUES (?,?,'in',?,'held',?,'message',0)",
        [id, f.peerId, id, `uds:${f.peerPath}`]);
    })();
    const latest = await f.message('prompting');
    await until(() => f.bridge.held().some(row => row.id === latest));
    await until(() => f.bridge.status().heldCount === 100);
    expect(f.db.query<{ status: string }, [string]>('SELECT status FROM messages WHERE id=?').get(ids[0]!)).toEqual({ status: 'dropped' });
    expect(f.desktop.submissions).toHaveLength(0);
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status'
      && frame.orig_msg_id === ids[0] && frame.drop_reason === 'queue-full'));
  } finally { await f.close(); }
});

test('the task name carries its directory, stays unique among live peers, and matches the envelope', async () => {
  const f = await fixture();
  try {
    const name = f.bridge.status().name;
    // Claude picks a target from the name alone, so it has to say which directory this task works in.
    expect(name).toBe(`codex-${basename(f.root).toLowerCase()}-${f.desktop.threadId.slice(-2)}`);
    // A second task in the same directory must not claim the name the registered receiver already holds.
    expect(sessionName(f.configDir, f.root, f.desktop.threadId)).toBe(`codex-${basename(f.root).toLowerCase()}-${f.desktop.threadId.slice(-4)}`);
    // The receiver replies to the name it was given, so the envelope and the registry have to agree.
    await f.bridge.sendMessage(f.peerId, 'named send');
    await until(() => f.frames.some(frame => frame.type === 'user' && frame.message.content.includes(`from-name="${name}"`)));
  } finally { await f.close(); }
});

test('list_sessions names the agent kind and start time and leaves out the calling task', async () => {
  const f = await fixture();
  const client = new Client({ name: 'list-test', version: '1.0.0' });
  const rows = z.array(z.object({ sessionId: z.string(), name: z.string(), agent: z.string(),
    cwd: z.string(), status: z.string(), startedAt: z.string().nullable() }));
  const list = async (threadId: string) => rows.parse(JSON.parse(z.array(z.object({ text: z.string() }))
    .parse((await client.callTool({ name: 'list_sessions', arguments: {}, _meta: { threadId } })).content)[0]!.text));
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    // A Codex task must not offer itself as a target, and a Claude peer has to read as one.
    const seen = await list(f.desktop.threadId);
    expect(seen.map(row => row.sessionId)).toEqual([f.peerId]);
    expect(seen[0]).toMatchObject({ agent: 'claude', cwd: f.root, startedAt: new Date(1700000000000).toISOString() });
    // Seen from another task, this receiver is a Codex peer and carries the start time that orders the list.
    const own = (await list(randomUUID())).find(row => row.sessionId === f.desktop.threadId);
    expect(own).toMatchObject({ agent: 'codex', name: f.bridge.status().name });
    expect(Date.parse(own?.startedAt ?? '')).toBeGreaterThan(1700000000000);
  } finally { await client.close(); await f.close(); }
});

test('batch drop receipts settle every correlated send and ignore late held receipts', async () => {
  const f = await fixture();
  try {
    const first = await f.bridge.sendMessage(f.peerId, 'first');
    const second = await f.bridge.sendMessage(f.peerId, 'second');
    await f.transmit({ type: 'control', action: 'peer_message_status', orig_msg_id: first.messageId,
      status: 'dropped', drop_reason: 'rate-limited', dropped_msg_ids: [second.messageId] });
    await until(() => f.bridge.status().messages.every(row => row.status === 'dropped'));
    expect(f.bridge.status().messages.every(row => row.drop_reason === 'rate-limited')).toBe(true);
    await f.transmit({ type: 'control', action: 'peer_message_status', orig_msg_id: first.messageId, status: 'held' });
    await Bun.sleep(30);
    expect(f.bridge.status().messages.every(row => row.status === 'dropped')).toBe(true);
  } finally { await f.close(); }
});

test('native guards run on delivery and held release; duplicate and hop drops report their reason', async () => {
  const f = await fixture();
  try {
    await f.message('prompting', 'repeat');
    const duplicate = await f.message('prompting', 'repeat');
    await until(() => f.bridge.status().messages.find(row => row.id === duplicate)?.status === 'dropped');
    expect(f.desktop.submissions).toHaveLength(1);
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status'
      && frame.orig_msg_id === duplicate && frame.drop_reason === 'duplicate'));
    await f.bridge.setPolicy('hold');
    await f.message('prompting', 'release repeated');
    const heldDuplicate = await f.message('prompting', 'release repeated');
    await until(() => f.bridge.status().heldCount === 2);
    await f.bridge.setPolicy('accept');
    expect(f.desktop.submissions).toHaveLength(2);
    expect(f.bridge.status().messages.find(row => row.id === heldDuplicate)?.status).toBe('dropped');

    const own = await f.bridge.sendMessage(f.peerId, 'obtain the public hop token');
    const content = f.frames.find(frame => frame.type === 'user' && frame.msg_id === own.messageId);
    if (!content || content.type !== 'user') throw new Error('Missing outgoing frame');
    const token = content.message.content.match(/hop-chain="([a-f0-9]{24})"/)?.[1];
    expect(token).toBeDefined();
    const loop = randomUUID();
    await f.transmit({ type: 'user', msg_id: loop, message: { role: 'user',
      content: `<cross-session-message hop-chain="${Array(10).fill(token).join(',')}">\nloop\n</cross-session-message>` } });
    await until(() => f.bridge.status().messages.find(row => row.id === loop)?.status === 'dropped');
    expect(f.desktop.submissions).toHaveLength(2);
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status'
      && frame.orig_msg_id === loop && frame.drop_reason === 'hop-loop'));
  } finally { await f.close(); }
});

test('size validation uses serialized characters before sending either text or its subscription; UTF-8 survives framing', async () => {
  const f = await fixture();
  try {
    await expect(f.bridge.sendMessage(f.peerId, 'x'.repeat(maxLineLength), true)).rejects.toThrow('serialized length');
    expect(f.frames).toHaveLength(0);
    expect(f.bridge.status().idleRequests).toHaveLength(0);
    const text = '€'.repeat(400000);
    await f.message(undefined, text);
    await until(() => f.desktop.submissions.length === 1);
    expect(JSON.stringify(f.desktop.submissions[0])).toContain(text);
    await f.bridge.sendMessage(f.peerId, text);
    const sent = f.frames.find(frame => frame.type === 'user');
    expect(sent?.type === 'user' && sent.message.content.includes(text)).toBe(true);
  } finally { await f.close(); }
});

test('the receiver refuses an exhausted outgoing burst before writing text or an attached subscription', async () => {
  const f = await fixture();
  const client = new Client({ name: 'burst-test', version: '1.0.0' });
  try {
    const address = f.bridge.status().replyAddress;
    if (!address) throw new Error('Missing receiver');
    const peer = findPeer(f.configDir, f.peerId);
    await sendFrames(f.configDir, peer, Array.from({ length: 30 }, (_, index) =>
      userFrame(peer, address, f.bridge.status().name ?? 'codex', randomUUID(), `message ${index}`, 'prompting', null)));
    expect(f.frames).toHaveLength(30);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    const result = await client.callTool({ name: 'send_message', arguments: { sessionId: f.peerId, text: 'blocked', notify_when_idle: true },
      _meta: { threadId: f.desktop.threadId } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Nothing sent');
    expect(f.bridge.status().messages[0]?.status).toBe('not-sent');
    expect(f.bridge.status().idleRequests.every(row => row.status === 'expired')).toBe(true);
    expect(f.frames).toHaveLength(30);
  } finally { await client.close(); await f.close(); }
});

test('native mode defaults hold mismatches; user decisions release once, refuse and expire without model input', async () => {
  const f = await fixture();
  try {
    const held = await f.message('bypass');
    await until(() => f.bridge.status().heldCount === 1);
    expect(f.desktop.submissions).toHaveLength(0);
    await f.bridge.resolveHeld(held, 'approve');
    await f.bridge.resolveHeld(held, 'approve');
    expect(f.desktop.submissions).toHaveLength(1);
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status' && frame.status === 'delivered'));

    f.bridge.updateRuntime({ status: 'idle', mode: 'bypass' });
    await f.message();
    await f.message('prompting');
    await until(() => f.bridge.status().heldCount === 2);
    await f.message('bypass');
    await until(() => f.desktop.submissions.length === 2);
    await f.bridge.setPolicy('hold');
    expect(f.db.query('SELECT 1 FROM messages WHERE status=\'held\' AND expires_at IS NOT NULL').get()).toBeNull();
    await f.bridge.setPolicy('refuse');
    expect(f.bridge.status().heldCount).toBe(0);
    expect(f.bridge.status().messages.filter(row => row.status === 'refused')).toHaveLength(2);
    const refused = await f.message('bypass');
    await until(() => f.bridge.status().messages.some(row => row.id === refused && row.status === 'refused'));
    expect(f.desktop.submissions).toHaveLength(2);
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status'
      && frame.orig_msg_id === refused && frame.status === 'expired' && frame.status_detail === 'refused'));

    await f.bridge.setPolicy('default');
    const expired = await f.message('prompting');
    await until(() => f.bridge.status().heldCount === 1);
    f.db.run('UPDATE messages SET expires_at=0 WHERE id=?', [expired]);
    await f.bridge.resolveHeld(expired, 'approve');
    expect(f.bridge.status().messages.find(row => row.id === expired)?.status).toBe('expired');
    expect(f.desktop.submissions).toHaveLength(2);
    expect(peers(f.configDir).find(peer => peer.sessionId === f.desktop.threadId)?.status).toBe('idle');
  } finally { await f.close(); }
}, 10000);

test('idle subscriptions are one-shot, do not start the watched task and ignore unsolicited or expired notices', async () => {
  const f = await fixture();
  try {
    const request = randomUUID();
    f.desktop.setState('active');
    f.bridge.updateRuntime({ status: 'busy', mode: 'prompting' });
    await f.transmit({ type: 'control', action: 'notify_when_idle', msg_id: request, from_mode: 'prompting' });
    await until(() => f.bridge.status().idleRequests.length === 1);
    expect(f.frames).toHaveLength(0);
    f.desktop.setState('idle');
    f.bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_idle_notice' && frame.orig_msg_id === request));
    await f.transmit({ type: 'control', action: 'notify_when_idle', msg_id: request });
    f.bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
    await Bun.sleep(200);
    expect(f.frames.filter(frame => frame.type === 'control' && frame.action === 'peer_idle_notice')).toHaveLength(1);
    expect(f.desktop.submissions).toHaveLength(0);

    const outgoing = await f.bridge.sendMessage(f.peerId, undefined, true);
    expect(outgoing.messageId).toBeNull();
    const notice = { type: 'control', action: 'peer_idle_notice', orig_msg_id: outgoing.subscriptionId, state: 'idle', finished_at: Date.now(), from_mode: 'prompting' };
    await f.transmit({ ...notice, orig_msg_id: randomUUID() });
    await f.transmit(notice);
    await until(() => f.desktop.submissions.length === 1);
    await f.transmit(notice);
    const next = await f.bridge.sendMessage(f.peerId, undefined, true);
    f.db.run('UPDATE idle_requests SET expires_at=0 WHERE id=?', [next.subscriptionId]);
    await f.transmit({ ...notice, orig_msg_id: next.subscriptionId });
    await Bun.sleep(200);
    expect(f.desktop.submissions).toHaveLength(2);
    expect(JSON.stringify(f.desktop.submissions[1])).toContain('idle_subscription_expired');
    expect(JSON.stringify(f.desktop.submissions[1])).not.toContain('peer_idle_notice');
  } finally { await f.close(); }
});

test('regular receiver shutdown expires held input and sends one exited notice to a waiting subscriber', async () => {
  const f = await fixture();
  try {
    const message = await f.message('bypass');
    await until(() => f.bridge.status().heldCount === 1);
    const request = randomUUID();
    await f.transmit({ type: 'control', action: 'notify_when_idle', msg_id: request });
    await until(() => f.bridge.status().idleRequests.length === 1);
    expect(f.desktop.submissions).toHaveLength(0);
    await f.bridge.close();
    await until(() => f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_idle_notice' && frame.orig_msg_id === request && frame.state === 'exited'));
    expect(f.frames.filter(frame => frame.type === 'control' && frame.action === 'peer_idle_notice')).toHaveLength(1);
    expect(f.frames.some(frame => frame.type === 'control' && frame.action === 'peer_message_status' && frame.orig_msg_id === message && frame.status === 'expired')).toBe(true);
    expect(f.desktop.submissions).toHaveLength(0);
  } finally { await f.close(); }
});

test('a held idle notice stays outside model input, even after accept; an expired subscription reports once', async () => {
  const f = await fixture();
  try {
    await f.bridge.setPolicy('hold');
    const request = await f.bridge.sendMessage(f.peerId, undefined, true);
    await f.transmit({ type: 'control', action: 'peer_idle_notice', orig_msg_id: request.subscriptionId,
      state: 'idle', detail: 'Private peer summary', from_mode: 'prompting' });
    await until(() => f.bridge.status().idleRequests.some(row => row.status === 'received'));
    expect(f.bridge.status().heldCount).toBe(0);
    await f.bridge.setPolicy('accept');
    expect(f.desktop.submissions).toHaveLength(0);
    const expired = await f.bridge.sendMessage(f.peerId, undefined, true);
    f.db.run('UPDATE idle_requests SET expires_at=0 WHERE id=?', [expired.subscriptionId]);
    f.bridge.updateRuntime({ status: 'busy', mode: 'prompting' });
    await until(() => f.desktop.submissions.length === 1);
    expect(JSON.stringify(f.desktop.submissions)).toContain('idle_subscription_expired');
    expect(JSON.stringify(f.desktop.submissions)).not.toContain('Private peer summary');
    f.bridge.updateRuntime({ status: 'idle', mode: 'prompting' });
    await Bun.sleep(50);
    expect(f.desktop.submissions).toHaveLength(1);
  } finally { await f.close(); }
});

test('the lifecycle hook opens held dialogs without model calls and shares manual review', async () => {
  const f = await fixture();
  const dialogs: { text: string; answer: ReturnType<typeof Promise.withResolvers<{ action: 'accept' | 'cancel'; content?: { decision: string } }>> }[] = [];
  const client = new Client({ name: 'automatic-dialog-test', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async request => {
    const answer = Promise.withResolvers<{ action: 'accept' | 'cancel'; content?: { decision: string } }>();
    dialogs.push({ text: request.params.message, answer });
    return answer.promise;
  });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    const started = await client.callTool({ name: 'session_start', arguments: { cwd: f.root }, _meta: { threadId: f.desktop.threadId } });
    expect(started).not.toHaveProperty('isError', true);
    const id = await f.message('bypass', 'private held payload');
    await until(() => dialogs.length === 1);
    expect(dialogs[0]?.text).toContain('private held payload');
    expect(f.desktop.submissions).toHaveLength(0);
    const manual = client.callTool({ name: 'inbox', arguments: { view: 'held' }, _meta: { threadId: f.desktop.threadId } });
    await Bun.sleep(600);
    expect(dialogs).toHaveLength(1);
    dialogs[0]!.answer.resolve({ action: 'accept', content: { decision: 'approve' } });
    const reviewed = await manual;
    expect(reviewed.isError).not.toBe(true);
    expect(JSON.stringify(reviewed)).not.toContain('private held payload');
    await until(() => f.desktop.submissions.length === 1);
    expect(f.bridge.status().messages.find(row => row.id === id)?.status).toBe('started');
    const denied = await f.message('bypass');
    await until(() => dialogs.length === 2);
    dialogs[1]!.answer.resolve({ action: 'cancel' });
    await until(() => f.bridge.status().messages.find(row => row.id === denied)?.status === 'denied');
    await f.bridge.setPolicy('hold');
    await f.message('bypass');
    await Bun.sleep(600);
    expect(dialogs).toHaveLength(2);
  } finally { await client.close(); await f.close(); }
});

test('automatic dialogs cancel on expiry and transport failures leave messages held', async () => {
  const f = await fixture();
  let requests = 0;
  let cancellations = 0;
  const aborted = Promise.withResolvers<void>();
  let fail = false;
  const client = new Client({ name: 'dialog-expiry-test', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
  // SDK 1.30 ignores cancellation of request ID 0; observe the actual wire notification.
  client.setNotificationHandler(CancelledNotificationSchema, async () => { cancellations++; aborted.resolve(); });
  client.setRequestHandler(ElicitRequestSchema, async () => {
    requests++;
    if (fail) throw new Error('Fixture transport failure');
    await aborted.promise;
    return { action: 'cancel' };
  });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    expect((await client.callTool({ name: 'session_start', arguments: { cwd: f.root }, _meta: { threadId: f.desktop.threadId } })).isError).not.toBe(true);
    const id = await f.message('bypass');
    await until(() => requests === 1);
    f.db.run('UPDATE messages SET expires_at=? WHERE id=?', [Date.now() - 1, id]);
    await until(() => cancellations === 1);
    await f.bridge.resolveHeld(id, 'approve');
    expect(f.bridge.status().messages.find(row => row.id === id)?.status).toBe('expired');
    expect(f.desktop.submissions).toHaveLength(0);
    fail = true;
    const failed = await f.message('bypass');
    await until(() => requests === 2);
    await Bun.sleep(600);
    expect(requests).toBe(2);
    expect(f.bridge.status().messages.find(row => row.id === failed)?.status).toBe('held');
  } finally { await client.close(); await f.close(); }
});

test('MCP cancellation leaves policy alone but denies a default-held message', async () => {
  const f = await fixture();
  let action: 'accept' | 'cancel' = 'cancel';
  let content: Record<string, string> = { policy: 'hold' };
  const client = new Client({ name: 'user-dialog-test', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action, ...(action === 'accept' ? { content } : {}) }));
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, '../src/server.ts')],
      env: { ...process.env, CODEX_HOME: f.root, CLAUDE_CONFIG_DIR: f.configDir } }));
    const subscription = await client.callTool({ name: 'send_message', arguments: { sessionId: f.peerId, notify_when_idle: true }, _meta: { threadId: f.desktop.threadId } });
    expect(subscription.isError).not.toBe(true);
    expect(f.frames.some(frame => frame.type === 'control' && frame.action === 'notify_when_idle' && frame.from === f.bridge.status().replyAddress)).toBe(true);
    const call = () => client.callTool({ name: 'inbox', arguments: { view: 'policy' }, _meta: { threadId: f.desktop.threadId } });
    expect((await call()).isError).not.toBe(true);
    expect(f.bridge.policy()).toBe('default');
    const held = await f.message('bypass');
    await until(() => f.bridge.status().heldCount === 1);
    expect((await client.callTool({ name: 'inbox', arguments: { view: 'held' }, _meta: { threadId: f.desktop.threadId } })).isError).not.toBe(true);
    expect(f.bridge.status().messages.find(row => row.id === held)?.status).toBe('denied');
    action = 'accept';
    expect((await call()).isError).not.toBe(true);
    expect(f.bridge.policy()).toBe('hold');
    await f.message('prompting');
    await until(() => f.bridge.status().heldCount === 1);
    expect(f.desktop.submissions).toHaveLength(0);
    content = { expiry: '60s' };
    expect((await client.callTool({ name: 'inbox', arguments: { view: 'expiry' }, _meta: { threadId: f.desktop.threadId } })).isError).not.toBe(true);
    expect(f.bridge.dialogExpiry()).toBe('60s');
    // The receiver owns the deadline even after the MCP process closes.
    await f.bridge.setPolicy('default');
    const deadlineMessage = await f.message('bypass');
    await until(() => f.bridge.status().heldCount === 1);
    f.db.run('UPDATE messages SET expires_at=? WHERE id=?', [Date.now() + 500, deadlineMessage]);
    content = { policy: 'default' };
    expect((await call()).isError).not.toBe(true);
    await client.close();
    await until(() => f.bridge.status().messages.find(row => row.id === deadlineMessage)?.status === 'expired');
  } finally { await client.close(); await f.close(); }
});
