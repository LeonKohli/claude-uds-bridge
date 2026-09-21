import { expect, setSystemTime, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BurstBudget, PeerGuard } from '../src/guard';

test('the native 30-message bucket refills one token in two seconds and keeps peers separate', () => {
  const db = new Database(':memory:');
  const guard = new PeerGuard(db);
  const budget = new BurstBudget();
  const start = Date.now();
  try {
    setSystemTime(start);
    for (let index = 0; index < 30; index++) {
      expect(budget.reserve('a')).toBe(true);
      expect(guard.admit('a', String(index), [], null)).toBeUndefined();
    }
    expect(budget.reserve('a')).toBe(false);
    expect(guard.admit('a', 'blocked', [], null)).toBe('rate-limited');
    expect(guard.admit('b', 'independent', [], null)).toBeUndefined();
    setSystemTime(start + 2000);
    expect(budget.reserve('a')).toBe(true);
    expect(guard.admit('a', 'refilled', [], null)).toBeUndefined();
    expect(guard.admit('a', 'refilled', [], null)).toBe('duplicate');
    setSystemTime(start + 32000);
    expect(guard.admit('a', 'refilled', [], null)).toBeUndefined();
    budget.credit('a');
    expect(budget.reserve('a')).toBe(true);
    const token = 'a'.repeat(24);
    expect(guard.admit('a', 'loop', Array(10).fill(token), token)).toBe('hop-loop');
    expect(guard.admit('a', 'long chain', Array(29).fill(token), null)).toBe('hop-runaway');
  } finally { setSystemTime(); db.close(); }
});
