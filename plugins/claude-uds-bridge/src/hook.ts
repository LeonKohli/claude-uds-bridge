import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import { Bridge } from './bridge';
import { peers, privateDirectory, processStart, uuid } from './claude';
import { watchDesktop } from './desktop';

const eventSchema = z.object({ session_id: uuid, cwd: z.string().refine(isAbsolute),
  hook_event_name: z.enum(['SessionStart', 'SessionEnd']), generation: uuid.optional() });
const event = eventSchema.parse(JSON.parse(await Bun.stdin.text()));
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const stateDir = join(codexHome, 'plugin-state', 'claude-uds-bridge');
const ipcPath = join(codexHome, 'ipc', 'ipc.sock');

function receiver() {
  const matches = peers(configDir).filter(peer => peer.sessionId === event.session_id
    && peer.entrypoint === 'codex-claude-uds-bridge');
  if (matches.length > 1) throw new Error('Multiple receivers claim this Codex task');
  return matches[0];
}

async function runReceiver() {
  const bridge = new Bridge(event.session_id, configDir, stateDir, ipcPath);
  let unwatch: (() => void) | undefined;
  let closing = false;
  let ready = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try { await bridge.close(); unwatch?.(); }
    finally { process.exit(0); }
  };
  process.once('SIGTERM', () => { void close(); });
  process.once('SIGINT', () => { void close(); });
  process.once('disconnect', () => { if (!ready) void close(); });
  try {
    unwatch = await watchDesktop(ipcPath, event.session_id, state => bridge.updateRuntime(state), () => { void close(); });
    const livePeer = peers(configDir)[0];
    let directory = livePeer ? dirname(livePeer.messagingSocketPath)
      : join(process.env.XDG_RUNTIME_DIR ?? process.env.CLAUDE_CODE_TMPDIR ?? '/tmp', 'cc-socks');
    try {
      if (Buffer.byteLength(join(directory, `${process.pid}.sock`)) > 103) throw new Error('Socket path too long');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      privateDirectory(directory);
    } catch {
      directory = `/tmp/cc-socks-${process.getuid?.()}`;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      privateDirectory(directory);
    }
    await bridge.start(directory, event.cwd, uuid.parse(event.generation));
    if (closing) throw new Error('Desktop closed during receiver startup');
    if (!process.connected) throw new Error('Session starter disconnected before readiness');
    ready = true;
    process.send?.({ ready: true }, error => { if (error) void close(); });
    process.disconnect?.();
  } catch (error) {
    if (process.connected) process.send?.({ error: error instanceof Error ? error.message : 'Receiver startup failed' }, () => {});
    await close();
  }
}

async function runHook() {
  const state = new Bridge(event.session_id, configDir, stateDir, ipcPath);
  try {
    if (event.hook_event_name === 'SessionEnd') {
      const owner = state.endSession();
      if (!owner) return;
      try { process.kill(owner.pid, 0); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
        throw error;
      }
      if (await processStart(owner.pid) !== owner.proc_start) return;
      process.kill(owner.pid, 'SIGTERM');
      const deadline = Date.now() + 2000;
      while (receiver() && Date.now() < deadline) await Bun.sleep(25);
      if (receiver()) throw new Error('Receiver did not stop');
      return;
    }
    const active = receiver();
    if (active) {
      if (!active.procStart || await processStart(active.pid) !== active.procStart) throw new Error('Receiver process identity changed');
      return;
    }
    await launchReceiver(state.beginSession());
  } finally { await state.close(); }
}

async function launchReceiver(generation: string) {
  const child = spawn(process.execPath, [z.string().min(1).parse(process.argv[1]), '--receive'],
    { detached: true, stdio: ['pipe', 'ignore', 'ignore', 'ipc'], env: process.env });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Receiver startup timed out')), 10000);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Receiver exited before readiness')));
      child.once('message', value => {
        const message = z.object({ ready: z.boolean().optional(), error: z.string().optional() }).safeParse(value);
        if (message.success && message.data.ready) resolve();
        else reject(new Error(message.success ? message.data.error : 'Invalid receiver readiness'));
      });
      child.stdin?.end(JSON.stringify({ ...event, generation }));
    });
  } catch (error) { child.kill('SIGTERM'); throw error; }
  finally { clearTimeout(timer); child.unref(); }
}

try {
  if (process.argv[2] === '--receive') await runReceiver();
  else await runHook();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Session receiver hook failed');
  process.exitCode = 1;
}
