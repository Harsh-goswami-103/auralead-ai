/**
 * Finds npm's own entry point so scripts and tests can run it with `process.execPath` (never npm.cmd,
 * CLAUDE.md). Under `npm run` it is `npm_execpath`; otherwise it sits next to the node binary:
 * `<node dir>/node_modules/npm/bin/npm-cli.js` on Windows, `<node dir>/../lib/node_modules/npm/...` on
 * POSIX installs.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

export function resolveNpmCli(env = process.env, execPath = process.execPath, exists = existsSync) {
  const fromEnv = env.npm_execpath;
  if (fromEnv && /npm-cli\.js$/.test(fromEnv) && exists(fromEnv)) return fromEnv;
  const nodeDir = path.dirname(execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((c) => exists(c));
  if (!found) throw new Error(`Cannot find npm-cli.js (looked at ${candidates.join(', ')}). Run through "npm run" or install npm next to node.`);
  return found;
}
