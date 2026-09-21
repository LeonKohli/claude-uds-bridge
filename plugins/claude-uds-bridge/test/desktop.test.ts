import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { deliverToDesktop, readDesktopInputs, readDesktopRuntime, watchDesktop, type Runtime } from "../src/desktop";
import { receiver } from "./desktop-fixture";

test('only committed input continues peer context; pending steering cannot replace a newer user input', async () => {
  const desktop = await receiver('active');
  const peer = randomUUID();
  const serverId = randomUUID();
  const user = { type: 'userMessage', id: randomUUID(), clientId: null };
  const steering = { type: 'steeringUserMessage', id: peer, clientUserMessageId: peer,
    status: 'accepted', serverUserMessageId: null };
  try {
    desktop.setHistory({ turns: [{ items: [user, steering] }] });
    expect((await readDesktopInputs(desktop.path, desktop.threadId)).latest).toEqual({ id: user.id, clientId: null });
    desktop.setHistory({ turns: [{ items: [user, { ...steering, serverUserMessageId: serverId }, { type: 'steered', id: serverId }] }] });
    const input = { id: serverId, clientId: peer };
    expect(await readDesktopInputs(desktop.path, desktop.threadId)).toEqual({ latest: input, consumed: [{ id: user.id, clientId: null }, input] });
    desktop.setHistory({ turns: [{ items: [{ ...steering, serverUserMessageId: serverId }, { type: 'steered', id: serverId }, user] }] });
    expect((await readDesktopInputs(desktop.path, desktop.threadId)).latest?.clientId).toBeNull();
  } finally { await desktop.close(); }
});

test('canonical history follows island order and refuses an incomplete latest history', async () => {
  const desktop = await receiver('idle');
  const first = { type: 'userMessage', id: randomUUID(), clientId: randomUUID() };
  const last = { type: 'userMessage', id: randomUUID(), clientId: randomUUID() };
  const history = { entitiesByKey: { last: { items: [last] }, first: { items: [first] } },
    islands: [{ entries: [{ value: 'first' }, { value: 'last' }], olderBoundary: { status: 'exhausted' }, newerBoundary: { status: 'exhausted' } }] };
  try {
    desktop.setHistory({ turns: [], turnHistory: { kind: 'canonical', history } });
    expect((await readDesktopInputs(desktop.path, desktop.threadId)).latest).toEqual({ id: last.id, clientId: last.clientId });
    history.islands[0]!.newerBoundary.status = 'loading';
    desktop.setHistory({ turns: [], turnHistory: { kind: 'canonical', history } });
    expect((await readDesktopInputs(desktop.path, desktop.threadId)).latest).toBeUndefined();
    desktop.setHistory({ turns: [], turnHistory: { kind: 'canonical', history: { ...history, islands: [] } } });
    expect((await readDesktopInputs(desktop.path, desktop.threadId)).latest).toBeUndefined();
  } finally { await desktop.close(); }
});

test('never with a sandbox is prompting; only unrestricted never is bypass', async () => {
  const desktop = await receiver('idle');
  try {
    for (const type of ['workspaceWrite', 'readOnly', 'externalSandbox']) {
      desktop.setPermissions({ approvalPolicy: 'never', sandboxPolicy: { type } });
      expect((await readDesktopRuntime(desktop.path, desktop.threadId)).mode).toBe('prompting');
    }
    desktop.setPermissions({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
    expect((await readDesktopRuntime(desktop.path, desktop.threadId)).mode).toBe('bypass');
    desktop.setPermissions({ approvalPolicy: 'never' });
    expect((await readDesktopRuntime(desktop.path, desktop.threadId)).mode).toBe('unknown');
  } finally { await desktop.close(); }
});

test.each(['idle', 'active'] as const)('Desktop %s delivery keeps the message and target identity', async state => {
  const desktop = await receiver(state);
  const messageId = randomUUID();
  try {
    const result = await deliverToDesktop(desktop.path, desktop.threadId, messageId, 'peer update');
    expect(result).toEqual({ status: state === 'active' ? 'steered' : 'started', turnId: desktop.turnId });
    expect(desktop.submissions).toHaveLength(1);
    const submission = desktop.submissions[0];
    expect(submission?.method).toBe(state === 'active' ? 'thread-follower-steer-turn' : 'thread-follower-start-turn');
    const params = z.object({ conversationId: z.uuid(), turnStart: z.object({ request: z.unknown() }).optional() }).parse(submission?.params);
    expect(params.conversationId).toBe(desktop.threadId);
    const input = z.object({ clientUserMessageId: z.uuid(), input: z.array(z.object({ text: z.string() })) })
      .parse(state === 'active' ? submission?.params : params.turnStart?.request);
    expect(input.clientUserMessageId).toBe(messageId);
    expect(input.input[0]?.text).toBe('peer update');
  } finally { await desktop.close(); }
});

test('the Desktop observer follows real status changes without submitting turns', async () => {
  const desktop = await receiver('idle');
  const states: Runtime[] = [];
  const close = await watchDesktop(desktop.path, desktop.threadId, state => states.push(state), () => {});
  try {
    expect(states).toEqual([{ status: 'idle', mode: 'prompting' }]);
    desktop.setState('active');
    const deadline = Date.now() + 1000;
    while (states.at(-1)?.status !== 'busy' && Date.now() < deadline) await Bun.sleep(5);
    expect(states.at(-1)).toEqual({ status: 'busy', mode: 'prompting' });
    desktop.setState('idle');
    while (states.at(-1)?.status !== 'idle' && Date.now() < deadline) await Bun.sleep(5);
    expect(states.at(-1)?.status).toBe('idle');
    expect(desktop.submissions).toHaveLength(0);
  } finally { close(); await desktop.close(); }
});

test('large task histories preserve observation, input attribution and delivery', async () => {
  const desktop = await receiver('idle');
  const states: Runtime[] = [];
  let disconnected = false;
  const close = await watchDesktop(desktop.path, desktop.threadId, state => states.push(state), () => { disconnected = true; });
  const user = { type: 'userMessage', id: randomUUID(), clientId: null };
  try {
    desktop.setHistory({ turns: [{ items: [
      { type: 'agentMessage', id: randomUUID(), text: 'x'.repeat(17 * 1024 * 1024) }, user,
    ] }] });
    desktop.setState('active');
    expect(await readDesktopInputs(desktop.path, desktop.threadId))
      .toEqual({ latest: { id: user.id, clientId: null }, consumed: [{ id: user.id, clientId: null }] });
    expect(await deliverToDesktop(desktop.path, desktop.threadId, randomUUID(), 'reply after a long task'))
      .toEqual({ status: 'steered', turnId: desktop.turnId });
    desktop.setState('idle');
    const deadline = Date.now() + 2000;
    while (states.at(-1)?.status !== 'idle' && Date.now() < deadline) await Bun.sleep(5);
    expect(states.at(-1)?.status).toBe('idle');
    expect(disconnected).toBe(false);
    expect(desktop.submissions).toHaveLength(1);
  } finally { close(); await desktop.close(); }
});

test('lost Desktop acknowledgement does not resend an accepted message', async () => {
  const desktop = await receiver('active', true);
  try {
    await expect(deliverToDesktop(desktop.path, desktop.threadId, randomUUID(), 'peer update')).rejects.toThrow();
    expect(desktop.submissions).toHaveLength(1);
  } finally { await desktop.close(); }
});

test('a turn ending before steering starts one new turn after explicit rejection', async () => {
  const desktop = await receiver('active', false, true);
  try {
    expect(await deliverToDesktop(desktop.path, desktop.threadId, randomUUID(), 'peer update'))
      .toEqual({ status: 'started', turnId: desktop.turnId });
    expect(desktop.submissions).toHaveLength(1);
    expect(desktop.submissions[0]?.method).toBe('thread-follower-start-turn');
  } finally { await desktop.close(); }
});
