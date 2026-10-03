import { test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const plugin = join(import.meta.dir, '..');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

test('package.json, the plugin manifest, and the marketplace agree on name and version', () => {
  const pkg = z.object({ name: z.string(), version: z.string() }).parse(read(join(plugin, 'package.json')));
  const manifest = z.object({ name: z.string(), version: z.string(), mcpServers: z.string() }).parse(read(join(plugin, '.codex-plugin/plugin.json')));
  const marketplace = z.object({ plugins: z.array(z.object({ name: z.string(), source: z.object({ path: z.string() }) })) })
    .parse(read(join(plugin, '../../.agents/plugins/marketplace.json')));
  expect(manifest.version).toBe(pkg.version);
  expect(manifest.name).toBe(pkg.name);
  expect(marketplace.plugins.map(entry => entry.name)).toContain(manifest.name);
  expect(existsSync(join(plugin, '../..', marketplace.plugins[0]!.source.path, '.codex-plugin/plugin.json'))).toBe(true);
});

test('the hooks run servers and bundles that exist', () => {
  const mcp = z.object({ mcpServers: z.record(z.string(), z.object({ args: z.array(z.string()) })) }).parse(read(join(plugin, '.mcp.json')));
  const hooks = JSON.stringify(read(join(plugin, 'hooks/hooks.json')));
  for (const [name, server] of Object.entries(mcp.mcpServers)) {
    for (const arg of server.args.filter(arg => arg.startsWith('./'))) expect(existsSync(join(plugin, arg))).toBe(true);
    if (hooks.includes('"type":"mcp_tool"')) expect(hooks).toContain(`"server":"${name}"`);
  }
  for (const bundle of hooks.match(/dist\/[a-z-]+\.js/g) ?? []) expect(existsSync(join(plugin, bundle))).toBe(true);
});
