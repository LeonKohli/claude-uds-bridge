import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Bridge } from './bridge';

export class HeldDialogs {
  private automatic = false;
  private closed = false;
  private failed = new Set<string>();
  private pending?: { id: string; abort: AbortController; result: Promise<{ action: string; messageId: string }> };
  private timer: ReturnType<typeof setInterval>;

  constructor(private bridge: Bridge, private server: McpServer) {
    this.timer = setInterval(() => this.tick(), 500);
    this.timer.unref();
  }

  start() { this.automatic = true; this.tick(); }

  private tick() {
    if (this.closed) return;
    const held = this.bridge.reviewableHeld();
    for (const id of this.failed) if (!held.some(message => message.id === id)) this.failed.delete(id);
    if (this.pending) {
      if (!held.some(message => message.id === this.pending?.id)) this.pending.abort.abort();
      return;
    }
    const next = held.find(message => !this.failed.has(message.id));
    if (this.automatic && next) void this.review(next.id).catch(() => console.error('Held dialog failed; message remains held.'));
  }

  async review(id?: string): Promise<{ action: string; messageId?: string }> {
    if (this.pending) return this.pending.result;
    const candidate = this.bridge.reviewableHeld().find(message => id === undefined || message.id === id);
    const held = candidate && this.bridge.held().find(message => message.id === candidate.id);
    if (!held || this.closed) return { action: 'unavailable' };
    const abort = new AbortController();
    const result = (async () => {
      try {
        const answer = await this.server.server.elicitInput({ mode: 'form',
          message: `Held message from an external agent. Sender: ${held.peer_id}\n\n${held.text}`,
          requestedSchema: { type: 'object', properties: { decision: { type: 'string', title: 'This message',
            enum: ['approve', 'deny'], enumNames: ['Accept: deliver to Codex', 'Deny: discard'] } }, required: ['decision'] } },
        { signal: abort.signal });
        if (abort.signal.aborted || this.closed) return { action: 'interrupted', messageId: held.id };
        await this.bridge.resolveHeld(held.id, answer.action === 'accept' ? z.enum(['approve', 'deny']).parse(answer.content?.decision) : 'deny');
        return { action: answer.action, messageId: held.id };
      } catch (error) {
        if (abort.signal.aborted || this.closed) return { action: 'interrupted', messageId: held.id };
        this.failed.add(held.id);
        throw error;
      } finally { this.pending = undefined; }
    })();
    this.pending = { id: held.id, abort, result };
    return result;
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.pending?.abort.abort();
    await this.pending?.result.catch(() => {});
  }
}
