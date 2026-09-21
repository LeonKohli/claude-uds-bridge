import { z } from 'zod';

const itemSchema = z.object({ type: z.string(), id: z.string(), clientId: z.string().nullable().optional(),
  clientUserMessageId: z.string().nullable().optional(), serverUserMessageId: z.string().nullable().optional() });
const turnSchema = z.object({ turnId: z.string().nullable().optional(), items: z.array(itemSchema),
  itemsPagination: z.object({ hasLoadedOldest: z.boolean().optional() }).optional() });
const historySchema = z.object({ entitiesByKey: z.record(z.string(), turnSchema), islands: z.array(z.object({
  entries: z.array(z.object({ value: z.string() })), olderBoundary: z.object({ status: z.string() }),
  newerBoundary: z.object({ status: z.string() }),
})) });

type Input = { id: string; clientId: string | null };
export type Inputs = { latest: Input | null | undefined; consumed: Input[] };

export function desktopInputs(state: { turns?: unknown; turnHistory?: unknown }): Inputs {
  const tail = z.array(turnSchema).safeParse(state.turns);
  const kind = z.object({ kind: z.string(), history: z.unknown().optional() }).safeParse(state.turnHistory);
  const unknown: Inputs = { latest: undefined, consumed: [] };
  if (!tail.success || !kind.success) return unknown;
  let turns = tail.data;
  let complete = true;
  if (kind.data.kind === 'canonical') {
    const parsed = historySchema.safeParse(kind.data.history);
    if (!parsed.success) return unknown;
    const island = parsed.data.islands.at(-1);
    if (!island || island.newerBoundary.status !== 'exhausted') return unknown;
    const ordered = island.entries.map(entry => parsed.data.entitiesByKey[entry.value]);
    if (ordered.some(turn => !turn)) return unknown;
    const canonical = ordered.filter(turn => turn !== undefined);
    // Overlapping history needs the host's item merge contract; never guess its input order.
    if (turns.some(turn => canonical.some(item => item.turnId === turn.turnId))) return unknown;
    turns = [...canonical, ...turns];
    complete = island.olderBoundary.status === 'exhausted';
  } else if (kind.data.kind !== 'legacy') return unknown;
  const consumed = new Map<string, Input>();
  for (const turn of turns) for (const item of turn.items) {
    if (item.type === 'userMessage') consumed.set(item.id, { id: item.id, clientId: item.clientId ?? null });
    if (item.type === 'steeringUserMessage' && item.serverUserMessageId) {
      consumed.set(item.serverUserMessageId, { id: item.serverUserMessageId, clientId: item.clientUserMessageId ?? null });
    }
  }
  for (const turn of turns.toReversed()) {
    for (const item of turn.items.toReversed()) {
      if (item.type === 'userMessage' || item.type === 'steered') {
        return { latest: consumed.get(item.id), consumed: [...consumed.values()] };
      }
    }
    if (turn.itemsPagination?.hasLoadedOldest === false) return { ...unknown, consumed: [...consumed.values()] };
  }
  return { latest: complete ? null : undefined, consumed: [...consumed.values()] };
}
