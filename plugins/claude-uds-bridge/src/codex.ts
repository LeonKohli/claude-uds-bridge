import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { AppServer, AppServerDisconnected, ThreadUnavailable, withAppServer } from './app-server';
import { privateDirectory } from './claude';
import { deliverToDesktop, readDesktopInputs, readDesktopRuntime, watchDesktop, type Runtime } from './desktop';

export const targetSchema = z.object({ kind: z.enum(['app-server', 'desktop']), path: z.string() });
export type Target = z.infer<typeof targetSchema>;

export function appServerSocket(codexHome: string) {
  const path = join(codexHome, 'app-server-control', 'app-server-control.sock');
  privateDirectory(dirname(path));
  const destination = lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : path;
  return join(realpathSync(dirname(destination)), basename(destination));
}

export async function discoverTarget(ipcPath: string, threadId: string): Promise<Target> {
  try {
    const target = { kind: 'app-server' as const, path: appServerSocket(dirname(dirname(ipcPath))) };
    await withAppServer(target.path, threadId, server => server.runtime());
    return target;
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && ['ENOENT', 'ECONNREFUSED'].includes(String(error.code));
    if (!missing && !(error instanceof ThreadUnavailable)) throw error;
  }
  return { kind: 'desktop', path: ipcPath };
}

export async function watchCodex(target: Target, threadId: string, onState: (state: Runtime) => void, onDisconnect: () => void) {
  if (target.kind === 'desktop') return watchDesktop(target.path, threadId, onState, onDisconnect);
  let server: AppServer | undefined;
  let stopped = false;
  let ready = false;
  let recovering = false;
  const close = () => { stopped = true; server?.close(); };
  const attach = async () => {
    server = new AppServer(target.path, threadId, error => { if (ready) void recover(error); });
    await server.connect();
    await server.observe(state => { if (!stopped) onState(state); });
    if (stopped) server.close();
  };
  const recover = async (error: unknown) => {
    if (stopped || recovering) return;
    recovering = true;
    onState({ status: 'unknown', mode: 'unknown' });
    const deadline = Date.now() + 30000;
    let delay = 250;
    while (!stopped && reconnectable(error) && Date.now() < deadline) {
      await Bun.sleep(delay);
      if (stopped) return;
      try { await attach(); recovering = false; return; }
      catch (failure) { server?.close(); error = failure; delay = Math.min(delay * 2, 2000); }
    }
    if (!stopped) { close(); onDisconnect(); }
  };
  try { await attach(); ready = true; return close; }
  catch (error) { close(); throw error; }
}

function reconnectable(error: unknown) {
  return error instanceof AppServerDisconnected || (error instanceof Error && 'code' in error
    && ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(String(error.code)));
}

export function readCodexRuntime(target: Target, threadId: string) {
  return target.kind === 'desktop' ? readDesktopRuntime(target.path, threadId)
    : withAppServer(target.path, threadId, server => server.runtime());
}

export function readCodexInputs(target: Target, threadId: string, awaiting: string[]) {
  return target.kind === 'desktop' ? readDesktopInputs(target.path, threadId)
    : withAppServer(target.path, threadId, server => server.inputs(awaiting));
}

export function deliverToCodex(target: Target, threadId: string, inputId: string, text: string) {
  return target.kind === 'desktop' ? deliverToDesktop(target.path, threadId, inputId, text)
    : withAppServer(target.path, threadId, server => server.submit(inputId, text));
}
