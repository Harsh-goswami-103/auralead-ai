/**
 * AT1 (T38): a clean copy of the repository comes up from `npm ci` and `npm run setup` alone.
 *
 * The copy is made from the files git would commit (tracked plus untracked, minus ignored), so a
 * file that only exists on a developer's disk cannot hide a missing dependency. Inside the copy:
 * `npm ci`, `npm run setup` (the only config), `db:deploy`, `db:seed`, `npm run build`, then the
 * built web app and the built worker start, GET /api/health answers 200, the worker writes a
 * heartbeat within 10 s of starting, and every panel page reachable from the three DEMO personas'
 * navigation answers 200 with no console error and no page error.
 *
 * Runs through `playwright.fresh.config.ts` (no global setup): `npm run verify` calls it, and it
 * is not part of the default projects because it installs and builds a second copy.
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse } from 'dotenv';
import getPort from 'get-port';
import { expect, test } from '@playwright/test';
import { resolveNpmCli } from '../../../scripts/npm-cli.mjs';
import { ROUTES } from '../../../src/server/routes.manifest';
import { killPidTree, POSIX_DETACH, REPO_ROOT } from '../../support/spawn';
import { baseEnv, hasFreshHeartbeat } from '../support/start-app';

const NPM_CLI = resolveNpmCli();

type Env = Record<string, string>;

function copyWorkingTree(target: string): number {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  let copied = 0;
  for (const rel of listed) {
    if (rel === '.claude' || rel.startsWith('.claude/')) continue; // agent worktrees and tool state
    const from = path.join(REPO_ROOT, rel);
    // Deleted in the working tree (not yet committed), or a nested repository / worktree listed as a directory.
    if (!existsSync(from) || !statSync(from).isFile()) continue;
    const to = path.join(target, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied += 1;
  }
  return copied;
}

function run(cwd: string, args: string[], env: Env, label: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: POSIX_DETACH });
    let output = '';
    child.stdout.on('data', (c: Buffer) => (output += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (output += c.toString('utf8')));
    const timer = setTimeout(() => {
      if (child.pid) void killPidTree(child.pid);
      reject(new Error(`${label} timed out after ${timeoutMs} ms\n${output.slice(-4000)}`));
    }, timeoutMs);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${label} exited ${code}\n${output.slice(-4000)}`));
    });
  });
}

test('a clean copy comes up from npm ci and npm run setup alone', async ({ browser }) => {
  test.setTimeout(30 * 60_000);
  const root = mkdtempSync(path.join(os.tmpdir(), 'auralead-fresh-'));
  const copy = path.join(root, 'repo');
  const dataDir = path.join(root, 'data');
  const pids: number[] = [];
  try {
    expect(copyWorkingTree(copy)).toBeGreaterThan(300);
    expect(existsSync(path.join(copy, '.env'))).toBe(false);
    expect(existsSync(path.join(copy, 'node_modules'))).toBe(false);

    const env: Env = { ...baseEnv(), AURALEAD_DATA_DIR: dataDir };
    await run(copy, [NPM_CLI, 'ci', '--no-audit', '--no-fund'], env, 'npm ci', 15 * 60_000);
    await run(copy, [NPM_CLI, 'run', 'setup'], env, 'npm run setup', 60_000);

    // Setup is the only configuration: every secret is filled in, nothing else is edited.
    const generated = parse(readFileSync(path.join(copy, '.env'), 'utf8'));
    for (const key of ['SESSION_SECRET', 'SHARE_NONCE_KEY', 'SUPPRESSION_PEPPER', 'CREDENTIALS_KEYRING']) expect(generated[key], key).toBeTruthy();
    expect(generated.APP_MODE).toBe('demo');

    await run(copy, [NPM_CLI, 'run', 'db:deploy'], env, 'db:deploy', 5 * 60_000);
    await run(copy, [NPM_CLI, 'run', 'db:seed'], env, 'db:seed', 5 * 60_000);
    await run(copy, [NPM_CLI, 'run', 'build'], env, 'npm run build', 15 * 60_000);

    const port = await getPort();
    const origin = `http://localhost:${port}`;
    const appEnv: Env = { ...env, APP_ORIGIN: origin };
    const web = spawn(process.execPath, [path.join(copy, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(port)], { cwd: copy, env: appEnv as NodeJS.ProcessEnv, stdio: 'ignore', windowsHide: true, detached: POSIX_DETACH });
    const startedAt = new Date();
    const worker = spawn(process.execPath, [path.join(copy, 'dist', 'worker.js')], { cwd: copy, env: appEnv as NodeJS.ProcessEnv, stdio: 'ignore', windowsHide: true, detached: POSIX_DETACH });
    pids.push(web.pid!, worker.pid!);

    const healthDeadline = performance.now() + 120_000;
    let healthy = false;
    while (performance.now() < healthDeadline && !healthy) {
      healthy = await fetch(`${origin}/api/health`).then((r) => r.status === 200, () => false);
      if (!healthy) await sleep(300);
    }
    expect(healthy, 'GET /api/health').toBe(true);

    const dbFile = path.join(dataDir, 'demo', 'app.db');
    const beatDeadline = performance.now() + 10_000;
    let beat = false;
    while (performance.now() < beatDeadline && !beat) {
      beat = existsSync(dbFile) && hasFreshHeartbeat(dbFile, worker.pid!, startedAt);
      if (!beat) await sleep(250);
    }
    expect(beat, 'worker heartbeat within 10 s').toBe(true);

    // AT1: every manifest page that needs no fixture (as its persona), the DEMO sign-in, /docs, and every
    // page reachable from each persona's navigation. All answer 200 with no console or page error.
    const context = await browser.newContext({ baseURL: origin });
    const problems: string[] = [];
    const visited: string[] = [];
    const personas = [
      { crawl: 'user', button: /^Workspace owner/ },
      { crawl: 'employee', button: /^Employee/ },
      { crawl: 'admin', button: /^Super admin/ },
    ] as const;
    const manifestPages = (who: string) =>
      ROUTES.filter((r) => r.kind === 'page' && r.params === undefined && !r.path.includes('[') && r.crawlAs?.includes(who as never)).map((r) => r.path);
    expect(manifestPages('anonymous').length, 'manifest has anonymous pages to crawl').toBeGreaterThan(2);

    const anon = await context.newPage();
    anon.on('console', (m) => {
      if (m.type() === 'error') problems.push(`${anon.url()} console: ${m.text()}`);
    });
    anon.on('pageerror', (e) => problems.push(`${anon.url()} pageerror: ${e.message}`));
    for (const href of [...new Set([...manifestPages('anonymous'), '/docs'])]) {
      const res = await anon.goto(href, { waitUntil: 'networkidle' });
      expect(res?.status(), href).toBe(200);
      visited.push(href);
    }
    const docLinks = await anon.locator('a[href^="/docs/"]').evaluateAll((as) => [...new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!))]);
    for (const href of docLinks) {
      const res = await anon.goto(href, { waitUntil: 'networkidle' });
      expect(res?.status(), href).toBe(200);
      visited.push(href);
    }
    await anon.close();

    for (const persona of personas) {
      const page = await context.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') problems.push(`${page.url()} console: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`${page.url()} pageerror: ${e.message}`));
      await page.goto('/login');
      await page.getByRole('button', { name: persona.button }).first().click();
      await page.waitForURL('**/dashboard/**');
      const home = new URL(page.url()).pathname;
      const links = await page.locator('a[href^="/dashboard/"]').evaluateAll((as) => [...new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!))]);
      const personaVisited = new Set<string>();
      for (const href of [home, ...manifestPages(persona.crawl), ...links.filter((h) => !h.includes('?') && h !== home)]) {
        if (personaVisited.has(href)) continue;
        const res = await page.goto(href, { waitUntil: 'networkidle' });
        expect(res?.status(), `${persona.crawl}: ${href}`).toBe(200);
        personaVisited.add(href);
        visited.push(href);
      }
      expect(personaVisited.size, `${persona.crawl} pages visited`).toBeGreaterThanOrEqual(3);
      await page.close();
    }
    expect(new Set(visited).size).toBeGreaterThanOrEqual(15);
    expect(problems).toEqual([]);
    await context.close();
  } finally {
    for (const pid of pids) await killPidTree(pid).catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
});
