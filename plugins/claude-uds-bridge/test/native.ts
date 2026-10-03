import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import WebSocket from 'ws';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { peers, uuid } from '../src/claude';

const root = mkdtempSync('/tmp/codex-native-');
const interactive = process.argv.includes('--interactive');
const peerFirst = interactive || process.argv.includes('--peer-first');
const peerArgument = process.argv.slice(2).find(argument => !['--peer-first', '--interactive'].includes(argument));
const livePeerId = peerArgument ? uuid.parse(peerArgument) : null;
const configDir = livePeerId ? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude') : join(root, 'claude');
const directory = join(root, 's');
mkdirSync(directory, { mode: 0o700 });
mkdirSync(join(configDir, 'sessions'), { recursive: true, mode: 0o700 });
mkdirSync(join(root, 'app-server-control'), { mode: 0o700 });
const path = join(root, 'app-server-control', 'app-server-control.sock');
const mcpEntry = process.env.UDS_MCP_TEST_ENTRYPOINT ?? join(import.meta.dir, '../src/server.ts');
const hooks = JSON.parse(readFileSync(join(import.meta.dir, '../hooks/hooks.json'), 'utf8'));
writeFileSync(join(root, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: hooks.hooks.SessionStart } }), { mode: 0o600 });
const requests: unknown[] = [];
const release = Promise.withResolvers<void>();
const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  requests.push(await request.json());
  const index = requests.length;
  if (index === 2) await release.promise;
  const events = [
    { type: 'response.created', response: { id: `response-${index}` } },
    { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `message-${index}`,
      content: [{ type: 'output_text', text: 'transport check complete' }] } },
    { type: 'response.completed', response: { id: `response-${index}`,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
} });
writeFileSync(join(root, 'config.toml'), `model = "gpt-6.1-sol"
model_provider = "bridge_test"
approval_policy = "on-request"
sandbox_mode = "read-only"
[features]
hooks = true
[mcp_servers.claude_uds_bridge]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(mcpEntry)}]
required = true
[mcp_servers.claude_uds_bridge.env]
CODEX_HOME = ${JSON.stringify(root)}
CLAUDE_CONFIG_DIR = ${JSON.stringify(configDir)}
[model_providers.bridge_test]
name = "Local transport test"
base_url = "http://127.0.0.1:${model.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[projects.${JSON.stringify(root)}]
trust_level = "trusted"
`, { mode: 0o600 });
const binary = process.env.CODEX_BRIDGE_TEST_BINARY ?? Bun.which('codex');
if (!binary) throw new Error('Install Codex or set CODEX_BRIDGE_TEST_BINARY');
const processCodex = Bun.spawn([binary, 'app-server', '--listen', `unix://${path}`],
  { env: { ...process.env, CODEX_HOME: root }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
const stdout = new Response(processCodex.stdout).text();
const stderr = new Response(processCodex.stderr).text();
const mcp = new Client({ name: 'native-bridge-test', version: '0.1.0' });
let socket: WebSocket | undefined;
let threadId: string | undefined;
let peer: net.Server | undefined;
let cli: Bun.Subprocess | undefined;
let terminal: Bun.Terminal | undefined;
let screen = '';
const pending = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
const until = async (predicate: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + (livePeerId ? 60000 : 15000);
  while (!await predicate() && Date.now() < deadline) await Bun.sleep(10);
  assert(await predicate(), 'Timed out waiting for native transport');
};
const rpc = async (method: string, params: unknown): Promise<unknown> => {
  const id = randomUUID();
  const reply = Promise.withResolvers<unknown>();
  pending.set(id, reply);
  const timer = setTimeout(() => reply.reject(new Error(`Timed out: ${method}`)), 15000);
  try { socket?.send(JSON.stringify({ id, method, params })); return await reply.promise; }
  finally { clearTimeout(timer); pending.delete(id); }
};
const hookEnd = async () => {
  if (!threadId) return;
  const hook = Bun.spawn([process.execPath, process.env.UDS_HOOK_TEST_ENTRYPOINT ?? join(import.meta.dir, '../src/hook.ts')],
    { env: { ...process.env, CODEX_HOME: root, CLAUDE_CONFIG_DIR: configDir }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  hook.stdin.write(JSON.stringify({ session_id: threadId, cwd: root, hook_event_name: 'SessionEnd' }));
  hook.stdin.end();
  const [code, error] = await Promise.all([hook.exited, new Response(hook.stderr).text()]);
  assert.equal(code, 0, error);
};
try {
  await until(() => existsSync(path));
  socket = new WebSocket(`ws+unix://${path}:/`);
  socket.on('error', error => { for (const reply of pending.values()) reply.reject(error); });
  socket.on('message', data => {
    const packet = JSON.parse(data.toString());
    if (packet.method) return;
    const reply = pending.get(packet.id);
    if (packet.error) reply?.reject(new Error(packet.error.message));
    else reply?.resolve(packet.result);
  });
  await once(socket, 'open');
  await rpc('initialize', { clientInfo: { name: 'native-bridge-test', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ method: 'initialized' }));
  const discovered = z.object({ data: z.array(z.object({ hooks: z.array(z.object({ key: z.string(), currentHash: z.string() })) })) })
    .parse(await rpc('hooks/list', { cwds: [root] })).data.flatMap(entry => entry.hooks);
  assert.equal(discovered.length, 1);
  for (const hook of discovered) await rpc('config/value/write', {
    keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: 'replace',
  });
  if (interactive) {
    terminal = new Bun.Terminal({ cols: 120, rows: 40, data(term, bytes) {
      const text = new TextDecoder().decode(bytes);
      screen += text;
      if (text.includes('\x1b[6n')) term.write('\x1b[1;1R');
      if (text.includes('\x1b[c')) term.write('\x1b[?1;2c');
      if (text.includes('\x1b[>c')) term.write('\x1b[>0;0;0c');
    } });
    cli = Bun.spawn([binary, '--remote', `unix://${path}`, '--no-alt-screen'], {
      cwd: root, env: { ...process.env, CODEX_HOME: root, TERM: 'xterm-256color' }, terminal,
    });
    await until(async () => {
      const loaded = z.object({ data: z.array(uuid) }).parse(await rpc('thread/loaded/list', {}));
      threadId = loaded.data[0];
      return !!threadId;
    });
  } else threadId = z.object({ thread: z.object({ id: uuid }) }).parse(await rpc('thread/start', { cwd: root })).thread.id;
  if (peerFirst) {
    assert.equal(requests.length, 0, 'Opening a chat must not call the model');
    assert(!peers(configDir).some(peer => peer.sessionId === threadId), 'Stock SessionStart waits for the first turn');
    await assert.rejects(rpc('thread/resume', { threadId, excludeTurns: true }), /no rollout found/);
    console.log(`Untouched ${interactive ? 'interactive CLI' : 'app-server'} chat: no model request, no receiver, observer resume unavailable.`);
    const text = 'first external instruction without user input';
    await rpc('turn/start', { threadId, input: [], toolOutput: {
      name: 'peer_message', namespace: 'claude_uds_bridge',
      output: JSON.stringify({ inputId: randomUUID(), content: text }),
    } });
    await until(() => requests.length === 1);
    const input = z.object({ input: z.array(z.object({ type: z.string(), output: z.unknown().optional(), role: z.string().optional() })) })
      .parse(requests[0]).input;
    assert(input.some(item => item.type === 'function_call_output' && JSON.stringify(item.output).includes(text)));
    assert(!input.some(item => item.role === 'user' && JSON.stringify(item).includes(text)), 'Peer instruction must retain tool authority');
  } else {
    await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Establish the transport test task.' }] });
    await until(() => requests.length === 1);
  }
  const idle = async () => z.object({ thread: z.object({ status: z.object({ type: z.string() }) }) })
    .parse(await rpc('thread/read', { threadId })).thread.status.type === 'idle';
  await until(idle);
  if (peerFirst) {
    const page = z.object({ data: z.array(z.object({ item: z.object({ type: z.string() }) })) })
      .parse(await rpc('thread/items/list', { threadId }));
    assert(!page.data.some(entry => entry.item.type === 'userMessage'), 'First peer turn must have no user message');
  }
  await until(() => peers(configDir).some(peer => peer.sessionId === threadId));
  const receiver = peers(configDir).find(peer => peer.sessionId === threadId);
  assert(receiver, 'Native SessionStart must register the CLI session without a prior tool call');
  const peerId = livePeerId ?? randomUUID();
  const peerPath = join(directory, `${process.pid}.sock`);
  const receipts: unknown[] = [];
  if (!livePeerId) {
    peer = net.createServer(connection => {
      connection.setEncoding('utf8');
      let buffer = '';
      connection.on('data', data => {
        buffer += data;
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) { receipts.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
      });
    });
    peer.listen(peerPath);
    await once(peer, 'listening');
    chmodSync(peerPath, 0o600);
    writeFileSync(join(configDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: peerId,
      messagingSocketPath: peerPath, cwd: root, peerProtocol: 1, peerFeatures: ['notify_idle'] }), { mode: 0o600 });
  } else assert(peers(configDir).some(peer => peer.sessionId === livePeerId), 'Live Claude peer must be registered');
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [mcpEntry],
    env: { ...process.env, CODEX_HOME: root, CLAUDE_CONFIG_DIR: configDir } }));
  const status = async () => {
    const result = await mcp.callTool({ name: 'status', arguments: {}, _meta: { threadId } });
    const content = z.array(z.object({ type: z.literal('text'), text: z.string() })).parse(result.content);
    return z.object({ transport: z.literal('app-server'), unreadCount: z.number(),
      messages: z.array(z.object({ id: z.string(), direction: z.string(), status: z.string() })),
      idleRequests: z.array(z.object({ id: z.string(), status: z.string() })) })
      .parse(JSON.parse(content[0]?.text ?? ''));
  };
  const nonce = randomUUID();
  const send = async (text: string) => {
    if (livePeerId) {
      const before = (await status()).messages.filter(message => message.direction === 'in' && message.status === 'accepted').length;
      const result = await mcp.callTool({ name: 'send_message', arguments: { sessionId: peerId,
        text: `Leon is testing the bridge. Use native SendMessage to reply to ${receiver.name} with exactly: ${text}` }, _meta: { threadId } });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      await until(async () => (await status()).messages.filter(message => message.direction === 'in' && message.status === 'accepted').length > before);
      return;
    }
    const id = randomUUID();
    const connection = net.createConnection(receiver.messagingSocketPath);
    await once(connection, 'connect');
    connection.end(JSON.stringify({ msgV: 1, type: 'user', msg_id: id, from: `uds:${peerPath}`, session_id: threadId,
      message: { role: 'user', content: text } }) + '\n');
    await once(connection, 'close');
    await until(async () => (await status()).messages.some(message => message.id === id && message.status === 'accepted'));
    assert(!receipts.some(receipt => z.object({ orig_msg_id: z.literal(id), status: z.literal('delivered') }).safeParse(receipt).success));
  };
  const texts = [`${nonce} native idle peer input`, `${nonce} native active peer input`];
  await send(texts[0]!);
  await until(() => requests.length === 2);
  await send(texts[1]!);
  release.resolve();
  await until(() => requests.length >= 3);
  await until(idle);
  if (interactive) await until(() => screen.includes('transport check complete'));
  const input = z.object({ input: z.array(z.object({ type: z.string(), output: z.unknown().optional(), role: z.string().optional() })) })
    .parse(requests.at(-1)).input;
  for (const text of texts) {
    assert(input.some(item => item.type === 'function_call_output' && JSON.stringify(item.output).includes(text)), `${text} must have tool authority`);
    assert(!input.some(item => item.role === 'user' && JSON.stringify(item).includes(text)), `${text} must not become user input`);
  }
  await until(async () => (await status()).unreadCount === 0);
  const state = await status();
  assert(state.messages.filter(message => message.status === 'accepted').length === 2);
  const outbound = await mcp.callTool({ name: 'send_message', arguments: { sessionId: peerId,
    text: livePeerId ? 'Both live protocol checks passed. No reply needed.' : 'native peer reply' }, _meta: { threadId } });
  assert.notEqual(outbound.isError, true, JSON.stringify(outbound));
  if (livePeerId) {
    const notice = await mcp.callTool({ name: 'send_message', arguments: { sessionId: peerId, notify_when_idle: true }, _meta: { threadId } });
    assert.notEqual(notice.isError, true, JSON.stringify(notice));
    await until(async () => (await status()).idleRequests.some(request => request.status === 'received'));
  } else assert(receipts.some(receipt => JSON.stringify(receipt).includes('native peer reply')));
  await hookEnd();
  assert(!peers(configDir).some(peer => peer.sessionId === threadId));
  console.log(`Stock Codex passed${peerFirst ? ' after direct backend peer initiation without user input' : ''}${livePeerId ? ' with real Claude, including idle notification' : ''}: SessionStart registration, idle and active delivery at tool authority, consumption, peer reply, shutdown.`);
} finally {
  release.resolve();
  await mcp.close();
  for (const receiver of peers(configDir)) if (receiver.sessionId === threadId) process.kill(receiver.pid, 'SIGTERM');
  socket?.terminate();
  cli?.kill();
  if (cli) await cli.exited;
  terminal?.close();
  if (interactive && !screen.includes('transport check complete')) console.error(screen);
  if (peer) await new Promise<void>(resolve => peer?.close(() => resolve()));
  processCodex.kill();
  await processCodex.exited;
  const output = await stdout;
  const error = await stderr;
  if (processCodex.exitCode && processCodex.exitCode !== 143) console.error(output, error);
  model.stop(true);
  rmSync(root, { recursive: true });
}
