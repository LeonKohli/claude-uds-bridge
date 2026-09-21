import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

// Mirrors the inbound limits Claude Code documents for peer messages: a 30-message burst
// that refills one message every two seconds, and identical repeats dropped within 30s.
// https://code.claude.com/docs/en/cross-session-messaging#limitations
export class BurstBudget {
  private senders = new Map<string, { tokens: number; updatedAt: number }>();

  private sender(key: string) {
    const now = Date.now();
    const sender = this.senders.get(key) ?? { tokens: 30, updatedAt: now };
    sender.tokens = Math.min(30, sender.tokens + Math.max(0, now - sender.updatedAt) / 2000);
    sender.updatedAt = now;
    this.senders.delete(key);
    this.senders.set(key, sender);
    if (this.senders.size > 256) {
      const oldest = this.senders.keys().next().value;
      if (oldest !== undefined) this.senders.delete(oldest);
    }
    return sender;
  }

  reserve(key: string) {
    const sender = this.sender(key);
    if (sender.tokens < 1) return false;
    sender.tokens--;
    return true;
  }

  credit(key: string) { const sender = this.sender(key); sender.tokens = Math.min(30, sender.tokens + 1); }
  debit(key: string) { const sender = this.sender(key); sender.tokens = Math.max(0, sender.tokens - 1); }
}

export class PeerGuard {
  constructor(private db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS peer_guard (
      sender TEXT PRIMARY KEY, tokens REAL NOT NULL, updated_at INTEGER NOT NULL, body TEXT NOT NULL, body_at INTEGER NOT NULL
    )`);
  }

  admit(sender: string, text: string, chain: string[], ownToken: string | null) {
    if (chain.length > 28) return 'hop-runaway';
    if (ownToken && chain.filter(token => token === ownToken).length >= 10) return 'hop-loop';
    return this.db.transaction(() => {
      const now = Date.now();
      const body = createHash('sha256').update(text).digest('hex');
      const previous = this.db.query<{ tokens: number; updated_at: number; body: string; body_at: number }, [string]>(
        'SELECT tokens,updated_at,body,body_at FROM peer_guard WHERE sender=?').get(sender);
      if (previous?.body === body && now - previous.body_at < 30000) return 'duplicate';
      const tokens = previous ? Math.min(30, previous.tokens + Math.max(0, now - previous.updated_at) / 2000) : 30;
      if (tokens < 1) return 'rate-limited';
      this.db.run('INSERT OR REPLACE INTO peer_guard VALUES (?,?,?,?,?)', [sender, tokens - 1, now, body, now]);
      this.db.run('DELETE FROM peer_guard WHERE sender IN (SELECT sender FROM peer_guard ORDER BY updated_at DESC,rowid DESC LIMIT -1 OFFSET 256)');
      return undefined;
    })();
  }
}
