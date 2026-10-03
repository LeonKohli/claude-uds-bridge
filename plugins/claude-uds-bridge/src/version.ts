import manifest from '../package.json';

// package.json owns the version. A test keeps .codex-plugin/plugin.json in step with it.
export const version = manifest.version;
