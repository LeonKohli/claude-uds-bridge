import WebSocket from 'ws';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { checkSocket, uuid } from './claude';
import type { Runtime } from './desktop';
import type { Inputs } from './desktop-input';

const statusSchema = z.object({ type: z.string() });
const threadSchema = z.object({ id: uuid, status: statusSchema, canAcceptDirectInput: z.boolean().nullable().optional() });
const permissionsSchema = z.object({ approvalPolicy: z.union([z.string(), z.record(z.string(), z.unknown())]),
  sandboxPolicy: z.object({ type: z.string() }) });
const packetSchema = z.object({ id: z.union([z.string(), z.number()]).optional(), result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(), method: z.string().optional(), params: z.unknown().optional() });
const pageSchema = z.object({ data: z.array(z.object({ item: z.object({ id: z.string(), type: z.string(),
  clientId: z.string().nullable().optional(), name: z.string().optional(), namespace: z.string().nullable().optional(), output: z.unknown().optional() }) })),
  nextCursor: z.string().nullable() });
const markerSchema = z.object({ inputId: uuid, content: z.string() });
type Input = NonNullable<Inputs['latest']>;

export class ThreadUnavailable extends Error {}
export class AppServerDisconnected extends Error {}

export class AppServer {
  private socket: WebSocket;
  private pending = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
  private mode: Runtime['mode'] = 'unknown';
  private settingsReceived = false;
  private stopped = false;
  private disconnectError?: Error;
  private onState?: (state: Runtime) => void;
  private refreshing = false;
  private dirty = false;

  constructor(path: string, readonly threadId: string, onDisconnect?: (error: Error) => void) {
    uuid.parse(threadId);
    checkSocket(path);
    this.socket = new WebSocket(`ws+unix://${path}:/`, { maxPayload: 256 * 1024 * 1024, perMessageDeflate: false });
    this.socket.on('error', error => { this.disconnectError = error; this.fail(error); });
    this.socket.on('close', () => {
      const error = this.disconnectError ?? new AppServerDisconnected('App-server disconnected; delivery may be unknown');
      this.fail(error);
      if (!this.stopped) onDisconnect?.(error);
    });
    this.socket.on('message', data => {
      try { this.read(packetSchema.parse(JSON.parse(data.toString()))); }
      catch (error) { this.disconnect(error instanceof Error ? error : new Error('Invalid app-server response')); }
    });
  }

  private fail(error: Error) { for (const pending of this.pending.values()) pending.reject(error); }

  private disconnect(error: Error) { this.disconnectError = error; this.fail(error); this.socket.terminate(); }

  private read(packet: z.infer<typeof packetSchema>) {
    if (packet.method) {
      // Subscribing also replays approval requests. Only the user's existing UI answers them.
      if (packet.id !== undefined) return;
      const thread = z.object({ threadId: z.string() }).safeParse(packet.params);
      if (!thread.success || thread.data.threadId !== this.threadId) return;
      if (packet.method === 'thread/settings/updated') {
        const settings = z.object({ threadSettings: permissionsSchema }).parse(packet.params);
        this.mode = permissionMode(settings.threadSettings);
        this.settingsReceived = true;
      }
      if (this.onState && ['thread/status/changed', 'thread/settings/updated', 'thread/queue/changed', 'item/completed'].includes(packet.method)) {
        void this.refresh().catch(error => this.disconnect(error));
      }
      return;
    }
    const pending = this.pending.get(String(packet.id));
    if (packet.error) pending?.reject(new Error(`App-server ${packet.error.code}: ${packet.error.message}`));
    else pending?.resolve(packet.result);
  }

  async request(method: string, params: unknown) {
    const id = randomUUID();
    const pending = Promise.withResolvers<unknown>();
    this.pending.set(id, pending);
    const timer = setTimeout(() => pending.reject(new Error('App-server request timed out; delivery may be unknown')), 10000);
    try {
      this.socket.send(JSON.stringify({ id, method, params }));
      return await pending.promise;
    } finally { clearTimeout(timer); this.pending.delete(id); }
  }

  async connect() {
    await once(this.socket, 'open', { signal: AbortSignal.timeout(5000) });
    await this.request('initialize', { clientInfo: { name: 'claude-uds-bridge', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.socket.send(JSON.stringify({ method: 'initialized' }));
    const { thread } = z.object({ thread: threadSchema }).parse(await this.request('thread/read', { threadId: this.threadId }));
    if (thread.id !== this.threadId || thread.status.type === 'notLoaded' || thread.canAcceptDirectInput === false) {
      throw new ThreadUnavailable('This app-server does not own a reachable live thread');
    }
  }

  async runtime(): Promise<Runtime> {
    const { thread } = z.object({ thread: threadSchema }).parse(await this.request('thread/read', { threadId: this.threadId }));
    if (thread.id !== this.threadId || thread.status.type === 'notLoaded') throw new ThreadUnavailable('The thread is no longer loaded');
    let status: Runtime['status'] = thread.status.type === 'idle' ? 'idle' : thread.status.type === 'active' ? 'busy' : 'unknown';
    if (status === 'idle') {
      const queue = z.object({ data: z.array(z.unknown()) }).parse(await this.request('thread/queue/list', { threadId: this.threadId, limit: 1 }));
      if (queue.data.length) status = 'busy';
    }
    return { status, mode: this.mode };
  }

  async observe(onState: (state: Runtime) => void) {
    const snapshot = z.object({ thread: threadSchema, approvalPolicy: permissionsSchema.shape.approvalPolicy,
      sandbox: permissionsSchema.shape.sandboxPolicy }).parse(
      await this.request('thread/resume', { threadId: this.threadId, excludeTurns: true }));
    if (snapshot.thread.id !== this.threadId || snapshot.thread.status.type === 'notLoaded' || snapshot.thread.canAcceptDirectInput === false) {
      throw new ThreadUnavailable('The resumed thread does not accept direct input');
    }
    if (!this.settingsReceived) this.mode = permissionMode({ approvalPolicy: snapshot.approvalPolicy, sandboxPolicy: snapshot.sandbox });
    this.onState = onState;
    await this.refresh();
  }

  private async refresh() {
    this.dirty = true;
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      while (this.dirty && !this.stopped) {
        this.dirty = false;
        this.onState?.(await this.runtime());
      }
    } finally { this.refreshing = false; }
  }

  async inputs(awaiting: string[] = []): Promise<Inputs> {
    const pending = new Set(awaiting);
    const consumed: Input[] = [];
    let latest: Inputs['latest'];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page = pageSchema.parse(await this.request('thread/items/list', { threadId: this.threadId, cursor, limit: 100, sortDirection: 'desc' }));
      for (const { item } of page.data) {
        let input: Input | undefined;
        if (item.type === 'userMessage') input = { id: item.id, clientId: item.clientId ?? null };
        if (item.type === 'functionCallOutput') input = { id: item.id, clientId: null };
        if (item.type === 'functionCallOutput' && item.name === 'peer_message' && item.namespace === 'claude_uds_bridge') {
          if (typeof item.output !== 'string') throw new Error('Invalid peer input correlation');
          const marker = markerSchema.parse(JSON.parse(item.output));
          input = { id: item.id, clientId: marker.inputId };
        }
        if (input) {
          latest ??= input;
          consumed.push(input);
          pending.delete(input.id);
          if (input.clientId) pending.delete(input.clientId);
        }
      }
      if (latest && !pending.size) break;
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('App-server repeated a history cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { latest: latest ?? null, consumed };
  }

  async submit(inputId: string, text: string) {
    uuid.parse(inputId);
    const result = z.object({ turn: z.object({ id: uuid }) }).parse(await this.request('turn/start', {
      threadId: this.threadId, input: [], toolOutput: { name: 'peer_message', namespace: 'claude_uds_bridge',
        output: JSON.stringify({ inputId, content: text }) },
    }));
    return { status: 'accepted', turnId: result.turn.id };
  }

  close() { this.stopped = true; this.socket.terminate(); }
}

function permissionMode(permissions: z.infer<typeof permissionsSchema>): Runtime['mode'] {
  if (permissions.approvalPolicy !== 'never') return 'prompting';
  const sandbox = permissions.sandboxPolicy.type;
  return sandbox === 'dangerFullAccess' ? 'bypass' : ['workspaceWrite', 'readOnly', 'externalSandbox'].includes(sandbox) ? 'prompting' : 'unknown';
}

export async function withAppServer<T>(path: string, threadId: string, operation: (server: AppServer) => Promise<T>) {
  const server = new AppServer(path, threadId);
  try { await server.connect(); return await operation(server); }
  finally { server.close(); }
}
