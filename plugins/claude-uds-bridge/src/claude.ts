// Claude Code's side of the local peer transport: the session registry under $CLAUDE_CONFIG_DIR/sessions
// and the newline-delimited frames its inbox socket accepts. Neither is a published API. The wire format
// follows PeterSR's reverse-engineering, checked against the documented behaviour.
// https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket
// https://github.com/PeterSR/claude-code-socket-transport/tree/480bd83c0bf1c63161c5afdb0976bbff849c926b
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readFileSync, readdirSync, lstatSync, chmodSync, mkdirSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { dirname, join, basename, isAbsolute } from 'node:path';
import { once } from 'node:events';
import { z } from 'zod';
import { BurstBudget } from './guard';

export const uuid = z.uuid();
export const maxLineLength = 1048576;
const sendBudget = new BurstBudget();
export class SendRefused extends Error {}
const registry = z.object({
  pid: z.number().int().positive(), sessionId: uuid, messagingSocketPath: z.string(),
  name: z.string().default('Claude Code'), cwd: z.string(), status: z.string().default('unknown'),
  peerProtocol: z.literal(1), procStart: z.string().optional(),
  entrypoint: z.string().optional(), startedAt: z.number().int().nonnegative().optional(),
  peerFeatures: z.array(z.string()).default([]),
});
export type Peer = z.infer<typeof registry>;
export const modeSchema = z.enum(['prompting', 'bypass']);
export const frameSchema = z.union([
  z.object({ msgV: z.literal(1), type: z.literal('user'), msg_id: uuid, from: z.string(),
    session_id: uuid.optional(), priority: z.literal('next').optional(),
    message: z.object({ role: z.literal('user'), content: z.string().min(1).max(maxLineLength) }) }),
  z.object({ msgV: z.literal(1), type: z.literal('control'), from: z.string(),
    action: z.literal('peer_message_status'), orig_msg_id: uuid,
    status: z.enum(['held', 'denied', 'expired', 'delivered', 'refused', 'dropped']), status_detail: z.string().optional(),
    drop_reason: z.string().optional(), dropped_msg_ids: z.array(uuid).max(256).optional() }),
  z.object({ msgV: z.literal(1), type: z.literal('control'), from: z.string(),
    action: z.literal('notify_when_idle'), msg_id: uuid, from_mode: z.string().optional() }),
  z.object({ msgV: z.literal(1), type: z.literal('control'), from: z.string(),
    action: z.literal('peer_idle_notice'), msg_id: uuid.optional(), orig_msg_id: uuid,
    state: z.string(), finished_at: z.number().finite().nonnegative().optional(), detail: z.string().max(65536).optional(), from_mode: z.string().optional() }),
]);
export type Frame = z.infer<typeof frameSchema>;

export function ownedJson(path: string, maxBytes: number): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > maxBytes) throw new Error('Invalid local metadata file');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

export function privateDirectory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new Error('Socket/state directory must be private and owned by the current user');
  }
}

export function checkSocket(path: string) {
  if (!isAbsolute(path) || path.split('/').includes('..')) throw new Error('Invalid socket path');
  privateDirectory(dirname(path));
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Invalid peer socket');
}

export function peers(configDir: string): Peer[] {
  const directory = join(configDir, 'sessions');
  let files: string[];
  try { files = readdirSync(directory); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; }
  const result: Peer[] = [];
  for (const file of files.filter(name => /^[1-9][0-9]*\.json$/.test(name))) {
    try {
      const peer = registry.parse(ownedJson(join(directory, file), 256 * 1024));
      if (file !== `${peer.pid}.json` || basename(peer.messagingSocketPath) !== `${peer.pid}.sock`) continue;
      process.kill(peer.pid, 0);
      checkSocket(peer.messagingSocketPath);
      result.push(peer);
    } catch { /* Ignore stale or incompatible session records. */ }
  }
  return result;
}

export function findPeer(configDir: string, sessionId: string): Peer {
  const matches = peers(configDir).filter(peer => peer.sessionId === sessionId);
  const peer = matches[0];
  if (!peer || matches.length !== 1) throw new Error('Claude session is unavailable or ambiguous; list sessions again');
  return peer;
}

export async function processStart(pid: number) {
  const child = Bun.spawn(['ps', '-o', 'lstart=', '-p', String(pid)],
    { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, stdout: 'pipe', stderr: 'ignore' });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code !== 0 || !output.trim()) throw new Error('Cannot verify receiver process');
  return output.trim();
}

// Claude's ListAgents gives the model only the name, so mirror its own <directory>-<suffix>
// default and lengthen the suffix until no live peer holds the name.
export function sessionName(configDir: string, cwd: string, sessionId: string) {
  const slug = basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
  // Codex derives a task folder from the opening prompt, so keep both ends: long ones differ at the tail.
  const folder = slug.length <= 22 ? slug
    : `${trim(slug.slice(0, 14))}-${trim(slug.slice(-7))}`;
  const taken = new Set(peers(configDir).map(peer => peer.name));
  const candidates = [2, 4, 8].map(length => `codex-${folder}-${sessionId.slice(-length)}`);
  return candidates.find(name => !taken.has(name)) ?? `codex-${folder}-${sessionId}`;
}

function trim(part: string) { return part.replace(/^-+|-+$/g, ''); }

export async function register(configDir: string, sessionId: string, address: string, cwd: string, status: string) {
  const directory = join(configDir, 'sessions');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  privateDirectory(directory);
  const path = join(directory, `${process.pid}.json`);
  const record = { pid: process.pid, sessionId, cwd, name: sessionName(configDir, cwd, sessionId),
    startedAt: Date.now(), procStart: await processStart(process.pid), peerProtocol: 1,
    ...(process.platform === 'darwin' ? { pidDomain: 'darwin' } : {}),
    kind: 'interactive', entrypoint: 'codex-claude-uds-bridge', messagingSocketPath: address.slice(4),
    status, statusUpdatedAt: Date.now(), peerFeatures: ['notify_idle'] };
  writeFileSync(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  const check = () => {
    const current = z.object({ sessionId: uuid, procStart: z.string() }).parse(ownedJson(path, 256 * 1024));
    if (current.sessionId !== sessionId || current.procStart !== record.procStart) throw new Error('Receiver registration changed');
  };
  return {
    close() { check(); unlinkSync(path); },
    update(status: string) {
      check();
      if (record.status === status) return;
      record.status = status;
      record.statusUpdatedAt = Date.now();
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, path);
    },
  };
}

export async function inbox(directory: string, receive: (frame: Frame) => void) {
  privateDirectory(directory);
  const path = join(directory, `${process.pid}.sock`);
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    const deadline = setTimeout(() => socket.destroy(), 30000);
    socket.once('close', () => clearTimeout(deadline));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        clearTimeout(deadline);
        if (end > maxLineLength) return void socket.destroy();
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const parsed = frameSchema.safeParse(JSON.parse(line));
          if (parsed.success) receive(parsed.data);
        } catch { socket.destroy(); return; }
      }
      if (buffer.length > maxLineLength) socket.destroy();
    });
  });
  const mask = process.umask(0o077);
  try { server.listen(path); await once(server, 'listening'); }
  finally { process.umask(mask); }
  chmodSync(path, 0o600);
  return {
    address: `uds:${path}`,
    close: () => new Promise<void>((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

export function senderMode(text: string) {
  const envelope = /^<cross-session-message\s[^>]*>/.exec(text)?.[0];
  return envelope?.match(/\sfrom-mode="([^"]*)"/)?.[1];
}

export function hopChain(text: string) {
  const value = /^<cross-session-message\s[^>]*>/.exec(text)?.[0].match(/\shop-chain="([a-f0-9]{24}(?:,[a-f0-9]{24}){0,31})"/)?.[1];
  return value?.split(',') ?? [];
}

// fromName must be the registered name: the receiver replies to what its ListAgents listing shows.
export function userFrame(peer: Peer, address: string, fromName: string, id: string, text: string, mode: string, token: string | null, previous: string[] = []) {
  const body = text.replaceAll('</cross-session-message', '<\\/cross-session-message');
  const chain = [...previous, ...(token ? [token] : [])].slice(-32).join(',');
  return { msgV: 1, msg_id: id, type: 'user', priority: 'next', from: address,
    session_id: peer.sessionId, message: { role: 'user', content:
      `<cross-session-message from="${address}"${chain ? ` hop-chain="${chain}"` : ''} from-name="${fromName}"${modeSchema.safeParse(mode).success ? ` from-mode="${mode}"` : ''}>\n${body}\n</cross-session-message>` } };
}

export function accountReceipt(peer: Peer, status: string, previous: string) {
  const key = `${peer.messagingSocketPath}:${peer.procStart ?? ''}`;
  if (status === 'held' && previous !== 'held') sendBudget.credit(key);
  else if (status === 'delivered' && previous === 'held') sendBudget.debit(key);
}

export async function sendFrames(configDir: string, peer: Peer, frames: unknown[], options: { canWrite?: () => boolean; timeoutMs?: number } = {}) {
  const lines = frames.map(serializeFrame);
  const users = frames.filter(frame => frameSchema.safeParse(frame).data?.type === 'user').length;
  const budgetKey = `${peer.messagingSocketPath}:${peer.procStart ?? ''}`;
  let reserved = 0;
  for (; reserved < users; reserved++) {
    if (!sendBudget.reserve(budgetKey)) {
      for (let count = 0; count < reserved; count++) sendBudget.credit(budgetKey);
      throw new SendRefused('Too many messages to this session just now: its 30-message burst budget is exhausted. Nothing sent; batch the remaining text or wait.');
    }
  }
  let written = false;
  try {
    if (peer.procStart && await processStart(peer.pid) !== peer.procStart) throw new Error('Peer process identity changed; list sessions again');
    checkSocket(peer.messagingSocketPath);
    const hash = createHash('sha256').update(peer.messagingSocketPath).digest('hex');
    const keyPath = join(configDir, 'sessions', `${peer.pid}.${hash}.key`);
    let token: string | undefined;
    try {
      const key = z.object({ peerToken: z.string().regex(/^[a-f0-9]{32}$/), procStart: z.string().optional() })
        .parse(ownedJson(keyPath, 4096));
      if (peer.procStart && key.procStart !== peer.procStart) throw new Error('Claude peer key belongs to a different process');
      token = key.peerToken;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const socket = net.createConnection(peer.messagingSocketPath);
    let socketError: Error | undefined;
    socket.on('error', error => { socketError = error; });
    try {
      await once(socket, 'connect', { signal: AbortSignal.timeout(options.timeoutMs ?? 5000) });
      if (options.canWrite && !options.canWrite()) return false;
      if (token) socket.write(JSON.stringify({ type: 'auth', token }) + '\n');
      written = true;
      await new Promise<void>((resolve, reject) => socket.write(lines.map(line => line + '\n').join(''), error => error ? reject(error) : resolve()));
      // Claude's macOS receiver can lose the last frame on an immediate half-close.
      await Bun.sleep(150);
      if (socketError) throw socketError;
      socket.end();
      return true;
    } finally { socket.destroy(); }
  } finally {
    if (!written) for (let count = 0; count < reserved; count++) sendBudget.credit(budgetKey);
  }
}

export function serializeFrame(frame: unknown) {
  const line = JSON.stringify(frame);
  if (typeof line !== 'string') throw new Error('Invalid outgoing frame');
  if (line.length > maxLineLength) throw new SendRefused(`Message too large: serialized length ${line.length} exceeds ${maxLineLength} characters; nothing sent`);
  return line;
}
