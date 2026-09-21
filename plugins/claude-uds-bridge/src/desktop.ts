// Codex desktop IPC at $CODEX_HOME/ipc/ipc.sock. This interface is internal and unversioned, so an
// app update can change it; delivery then fails as 'unknown' rather than silently doing the wrong thing.
// Stream payloads are pinned to version 11 below for that reason.
import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { checkSocket, uuid } from './claude';
import { desktopInputs } from './desktop-input';

const packetSchema = z.object({
  type: z.string(), requestId: z.string().optional(), sourceClientId: z.string().optional(),
  handledByClientId: z.string().optional(), resultType: z.enum(['success', 'error']).optional(),
  result: z.unknown().optional(), error: z.string().optional(), method: z.string().optional(),
  version: z.number().optional(), params: z.unknown().optional(),
});
type Packet = z.infer<typeof packetSchema>;
const maxDesktopFrameBytes = 256 * 1024 * 1024;
const snapshotSchema = z.object({ cwd: z.string().min(1), threadRuntimeStatus: z.object({ type: z.string() }),
  turns: z.unknown().optional(), turnHistory: z.unknown().optional(),
  currentPermissions: z.object({ approvalPolicy: z.union([z.string(), z.record(z.string(), z.unknown())]),
    sandboxPolicy: z.object({ type: z.string() }).optional() }).optional() });
type Snapshot = z.infer<typeof snapshotSchema>;
export type Runtime = { status: 'idle' | 'busy' | 'unknown'; mode: 'prompting' | 'bypass' | 'unknown' };
const acceptedSchema = z.object({ result: z.union([
  z.object({ turn: z.object({ id: uuid }) }), z.object({ turnId: uuid }),
]) });

class Rejected extends Error {}

function permissionMode(permissions: Snapshot['currentPermissions']): Runtime['mode'] {
  if (!permissions) return 'unknown';
  if (permissions.approvalPolicy !== 'never') return 'prompting';
  const sandbox = permissions.sandboxPolicy?.type;
  if (sandbox === 'dangerFullAccess') return 'bypass';
  return sandbox && ['workspaceWrite', 'readOnly', 'externalSandbox'].includes(sandbox) ? 'prompting' : 'unknown';
}

class DesktopConnection {
  private socket: net.Socket;
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private frameBytes = 0;
  private frameLength = 0;
  private frameChunks: Buffer[] = [];
  private clientId = 'initializing-client';
  private ownerId?: string;
  private pending = new Map<string, ReturnType<typeof Promise.withResolvers<Packet>>>();
  private snapshotResult?: ReturnType<typeof Promise.withResolvers<Snapshot>>;
  private onState?: (state: Runtime) => void;
  private observed?: Runtime;
  private refreshing = false;
  private dirty = false;

  constructor(path: string, readonly threadId: string, onDisconnect?: () => void) {
    checkSocket(path);
    this.socket = net.createConnection(path);
    this.socket.on('data', chunk => this.read(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    this.socket.on('error', error => this.fail(error));
    this.socket.on('close', () => {
      this.fail(new Error('Desktop IPC disconnected; delivery may be unknown'));
      onDisconnect?.();
    });
  }

  private fail(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.snapshotResult?.reject(error);
  }

  async connectHost() {
    await once(this.socket, 'connect', { signal: AbortSignal.timeout(5000) });
    const initialized = await this.request('initialize', { clientType: 'claude-uds-bridge' }, 0);
    this.clientId = z.object({ clientId: z.string().min(1) }).parse(initialized.result).clientId;
  }

  async connect() {
    await this.connectHost();
    const owner = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: this.threadId }, 1);
    z.object({ supportsUntrustedAppInput: z.literal(true) }).parse(owner.result);
    this.ownerId = z.string().min(1).parse(owner.handledByClientId);
  }

  private write(packet: unknown) {
    if (this.socket.destroyed) throw new Error('Desktop IPC is closed');
    const body = Buffer.from(JSON.stringify(packet));
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length);
    body.copy(frame, 4);
    this.socket.write(frame);
  }

  private async request(method: string, params: unknown, version: number) {
    const id = randomUUID();
    const pending = Promise.withResolvers<Packet>();
    this.pending.set(id, pending);
    const timer = setTimeout(() => pending.reject(new Error('Desktop request timed out; delivery may be unknown')), 15000);
    try {
      this.write({ type: 'request', requestId: id, sourceClientId: this.clientId,
        ...(this.ownerId ? { targetClientId: this.ownerId } : {}), method, params, version, timeoutMs: 12000 });
      return await pending.promise;
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  private follow(following: boolean) {
    this.write({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1,
      sourceClientId: this.clientId, targetClientIds: [this.ownerId],
      params: { conversationId: this.threadId, hostId: 'local', following } });
  }

  private async snapshot() {
    const pending = Promise.withResolvers<Snapshot>();
    this.snapshotResult = pending;
    const timer = setTimeout(() => pending.reject(new Error('Desktop snapshot timed out')), 10000);
    try { this.follow(true); return await pending.promise; }
    finally { clearTimeout(timer); this.snapshotResult = undefined; }
  }

  async observe(onState: (state: Runtime) => void) {
    this.onState = onState;
    await this.refresh();
  }

  async runtime(): Promise<Runtime> {
    const state = await this.snapshot();
    return { status: state.threadRuntimeStatus.type === 'idle' ? 'idle'
      : state.threadRuntimeStatus.type === 'active' ? 'busy' : 'unknown',
      mode: permissionMode(state.currentPermissions) };
  }

  async inputs() { return desktopInputs(await this.snapshot()); }

  private async refresh() {
    this.dirty = true;
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      while (this.dirty && !this.socket.destroyed) {
        this.dirty = false;
        this.report(await this.runtime());
      }
    } finally { this.refreshing = false; }
  }

  private report(state: Runtime) {
    if (state.status === this.observed?.status && state.mode === this.observed.mode) return;
    this.observed = state;
    this.onState?.(state);
  }

  async submit(text: string, messageId: string) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.submitOnce(text, messageId); }
      catch (error) {
        if (attempt !== 0 || !(error instanceof Rejected)
          || error.message !== `Cannot steer conversation ${this.threadId} because its active turn already ended`) throw error;
      }
    }
  }

  private async submitOnce(text: string, messageId: string) {
    const state = await this.snapshot();
    const input = [{ type: 'text', text, text_elements: [] }];
    const conversationId = this.threadId;
    let response: Packet;
    let status: 'started' | 'steered';
    if (state.threadRuntimeStatus.type === 'idle') {
      status = 'started';
      response = await this.request('thread-follower-start-turn', { conversationId,
        turnStart: { request: { threadId: conversationId, clientUserMessageId: messageId, input },
          context: { responseItems: [], inheritThreadSettings: true } },
      }, 2);
    } else if (state.threadRuntimeStatus.type === 'active') {
      status = 'steered';
      response = await this.request('thread-follower-steer-turn', { conversationId, clientUserMessageId: messageId, input,
        restoreMessage: { id: messageId, text, cwd: state.cwd, createdAt: Date.now(),
          context: { prompt: text, addedFiles: [], fileAttachments: [], ideContext: null,
            imageAttachments: [], workspaceRoots: [state.cwd], commentAttachments: [] },
          responsesapiClientMetadata: {} },
      }, 1);
    } else throw new Error('Codex task is neither active nor idle');
    const accepted = acceptedSchema.parse(response.result).result;
    return { status, turnId: 'turnId' in accepted ? accepted.turnId : accepted.turn.id };
  }

  private read(chunk: Buffer) {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.frameLength === 0) {
          const size = Math.min(4 - this.headerBytes, chunk.length - offset);
          chunk.copy(this.header, this.headerBytes, offset, offset + size);
          this.headerBytes += size;
          offset += size;
          if (this.headerBytes < 4) return;
          this.frameLength = this.header.readUInt32LE();
          this.headerBytes = 0;
          if (this.frameLength === 0 || this.frameLength > maxDesktopFrameBytes) {
            throw new Error(`Invalid Desktop IPC frame size: ${this.frameLength} bytes (limit ${maxDesktopFrameBytes})`);
          }
        }
        const size = Math.min(this.frameLength - this.frameBytes, chunk.length - offset);
        if (size > 0) this.frameChunks.push(chunk.subarray(offset, offset + size));
        this.frameBytes += size;
        offset += size;
        if (this.frameBytes < this.frameLength) return;
        const body = Buffer.concat(this.frameChunks, this.frameLength);
        this.frameChunks = [];
        this.frameBytes = 0;
        this.frameLength = 0;
        const packet = packetSchema.parse(JSON.parse(body.toString('utf8')));
        if (packet.type === 'client-discovery-request' && packet.requestId) {
          this.write({ type: 'client-discovery-response', requestId: packet.requestId, response: { canHandle: false } });
        } else if (packet.type === 'response' && packet.requestId) {
          const pending = this.pending.get(packet.requestId);
          if (packet.resultType === 'success') pending?.resolve(packet);
          else pending?.reject(new Rejected(packet.error ?? 'Desktop request rejected'));
        } else if (packet.type === 'broadcast' && packet.method === 'thread-stream-state-changed'
          && packet.sourceClientId === this.ownerId) {
          const params = z.object({ conversationId: z.string(), change: z.object({ type: z.string(), conversationState: z.unknown().optional(),
            patches: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), value: z.unknown().optional() })).optional() }) }).parse(packet.params);
          if (params.conversationId !== this.threadId) continue;
          if (packet.version !== 11) throw new Error('Unsupported Desktop stream version');
          if (params.change.type === 'snapshot') this.snapshotResult?.resolve(snapshotSchema.parse(params.change.conversationState));
          else if (this.onState && params.change.type === 'patches' && params.change.patches?.some(patch =>
            patch.path.length === 0 || ['threadRuntimeStatus', 'currentPermissions'].includes(String(patch.path[0])))) {
            if (this.observed) {
              const state = { ...this.observed };
              for (const patch of params.change.patches ?? []) {
                if (!patch.path.length) { state.status = 'unknown'; state.mode = 'unknown'; }
                else if (patch.path[0] === 'threadRuntimeStatus' && patch.path.length === 1) {
                  const value = snapshotSchema.shape.threadRuntimeStatus.safeParse(patch.value).data?.type;
                  state.status = value === 'idle' ? 'idle' : value === 'active' ? 'busy' : 'unknown';
                } else if (patch.path[0] === 'threadRuntimeStatus') state.status = 'unknown';
                else if (patch.path[0] === 'currentPermissions' && patch.path.length === 1) {
                  const value = snapshotSchema.shape.currentPermissions.safeParse(patch.value).data;
                  state.mode = permissionMode(value);
                } else if (patch.path[0] === 'currentPermissions') state.mode = 'unknown';
              }
              this.report(state);
            }
            void this.refresh().catch(() => this.socket.destroy());
          }
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Invalid Desktop IPC frame'));
      this.socket.destroy();
    }
  }

  close() {
    if (!this.socket.destroyed && this.ownerId) this.follow(false);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 250).unref();
  }
}

export async function watchDesktop(path: string, threadId: string, onState: (state: Runtime) => void, onDisconnect: () => void) {
  const connection = new DesktopConnection(path, threadId, onDisconnect);
  try { await connection.connect(); await connection.observe(onState); return () => connection.close(); }
  catch (error) { connection.close(); throw error; }
}

export async function deliverToDesktop(path: string, threadId: string, messageId: string, text: string) {
  uuid.parse(threadId);
  uuid.parse(messageId);
  const connection = new DesktopConnection(path, threadId);
  try { await connection.connect(); return await connection.submit(text, messageId); }
  finally { connection.close(); }
}

export async function readDesktopRuntime(path: string, threadId: string) {
  const connection = new DesktopConnection(path, threadId);
  try { await connection.connect(); return await connection.runtime(); }
  finally { connection.close(); }
}

export async function readDesktopInputs(path: string, threadId: string) {
  const connection = new DesktopConnection(path, threadId);
  try { await connection.connect(); return await connection.inputs(); }
  finally { connection.close(); }
}
