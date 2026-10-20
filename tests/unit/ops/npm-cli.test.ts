/**
 * T38: scripts and E2E tests run npm through `process.execPath` and npm's own entry point, never
 * npm.cmd (CLAUDE.md). The entry point sits in different places on Windows and POSIX installs.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveNpmCli } from '../../../scripts/npm-cli.mjs';

describe('resolveNpmCli', () => {
  it('prefers npm_execpath when it is npm-cli.js', () => {
    expect(resolveNpmCli({ npm_execpath: '/x/npm/bin/npm-cli.js' }, '/usr/bin/node', () => true)).toBe('/x/npm/bin/npm-cli.js');
  });

  it('ignores other package managers in npm_execpath', () => {
    const win = path.join('C:/nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const found = resolveNpmCli({ npm_execpath: '/x/pnpm/bin/pnpm.cjs' }, path.join('C:/nodejs', 'node.exe'), (p) => p === win);
    expect(found).toBe(win);
  });

  it('finds the Windows layout (npm next to node.exe)', () => {
    const win = path.join('C:/nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    expect(resolveNpmCli({}, path.join('C:/nodejs', 'node.exe'), (p) => p === win)).toBe(win);
  });

  it('finds the POSIX layout (npm under ../lib)', () => {
    const posix = path.join('/usr/local/bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    expect(resolveNpmCli({}, '/usr/local/bin/node', (p) => p === posix)).toBe(posix);
  });

  it('says where it looked when npm is missing', () => {
    expect(() => resolveNpmCli({}, '/opt/node/bin/node', () => false)).toThrow(/Cannot find npm-cli\.js/);
  });
});
