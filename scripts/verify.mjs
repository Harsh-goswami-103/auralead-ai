/**
 * `npm run verify` (T38, AT16): the acceptance run. Every step must exit 0:
 *
 *   typecheck  ->  lint  ->  unit/integration/component tests  ->  dependency audit (production,
 *   high+)  ->  Playwright (its global setup runs `next build` for DEMO and LIVE plus the worker
 *   build, starts both built apps and the built worker on free ports against temp databases, then
 *   runs the smoke and panel projects)  ->  fresh-copy setup test (AT1).
 *
 * Results go to test-results/verify-summary.json, and the integration evidence matrix from
 * docs/integrations.md is printed (P18) with a check that every cited live-verification evidence
 * path exists. The matrix never turns a step red by itself: it reports what is NOT live-verified.
 *
 *   node scripts/verify.mjs                  all steps, stop at the first failure
 *   node scripts/verify.mjs --keep-going     run every step, report all failures at the end
 *   node scripts/verify.mjs --only lint,test run just those steps
 *   node scripts/verify.mjs --skip e2e,fresh skip steps (reported as SKIPPED, never as passed)
 *
 * Children are started with process.execPath and the tools' own entry points, never npm.cmd.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNpmCli } from './npm-cli.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = (...parts) => path.join(root, 'node_modules', ...parts);
const npmCli = resolveNpmCli();

export const STEPS = [
  { id: 'typecheck', title: 'TypeScript', args: [bin('typescript', 'bin', 'tsc'), '--noEmit'] },
  { id: 'lint', title: 'ESLint', args: [bin('eslint', 'bin', 'eslint.js'), '.'] },
  { id: 'test', title: 'Vitest (unit, integration, components)', args: [bin('vitest', 'vitest.mjs'), 'run'], env: { TZ: 'America/New_York' } },
  { id: 'audit', title: 'npm audit (production dependencies, high and above)', args: [npmCli, 'audit', '--omit=dev', '--audit-level=high'] },
  { id: 'e2e', title: 'Playwright (builds, starts built app + worker, smoke and panel projects)', args: [bin('@playwright/test', 'cli.js'), 'test'], env: { E2E_SKIP_BUILD: '0' } },
  { id: 'fresh', title: 'Fresh copy: npm ci, setup, build, start (AT1)', args: [bin('@playwright/test', 'cli.js'), 'test', '--config', 'playwright.fresh.config.ts'], env: { E2E_SKIP_BUILD: '0' } },
];

function parseArgs(argv) {
  const opts = { keepGoing: false, only: null, skip: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep-going') opts.keepGoing = true;
    else if (argv[i] === '--only') opts.only = new Set((argv[++i] ?? '').split(',').filter(Boolean));
    else if (argv[i] === '--skip') for (const id of (argv[++i] ?? '').split(',').filter(Boolean)) opts.skip.add(id);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  const known = new Set(STEPS.map((s) => s.id));
  for (const id of [...(opts.only ?? []), ...opts.skip]) if (!known.has(id)) throw new Error(`unknown step "${id}" (steps: ${[...known].join(', ')})`);
  return opts;
}

function runStep(step) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, step.args, { cwd: root, env: { ...process.env, ...step.env, CHECKPOINT_DISABLE: '1', FORCE_COLOR: '0' }, stdio: 'inherit', windowsHide: true });
    child.on('error', (error) => resolve({ code: 1, ms: Date.now() - started, error: String(error) }));
    child.on('exit', (code, signal) => resolve({ code: code ?? 1, signal, ms: Date.now() - started }));
  });
}

/** Parses the status matrix of docs/integrations.md: one object per table row under "## Status matrix". */
export function parseEvidenceMatrix(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Status matrix/i.test(l));
  if (start < 0) return [];
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.length < 5 || /^-+$/.test(cells[1].replace(/\s/g, '')) || /^integration$/i.test(cells[0])) continue;
    rows.push({ integration: cells[0], implemented: cells[1], fixtureTested: cells[2], demoVerified: cells[3], liveVerified: cells[4] });
  }
  return rows;
}

/** A live-verified cell is `No` or `<date> <repo-relative evidence path>`; the path must exist. */
export function checkLiveEvidence(row, exists = (p) => existsSync(path.join(root, p))) {
  const cell = row.liveVerified;
  if (/^no\b/i.test(cell)) return { ok: true, claimed: false };
  const match = /^(\d{4}-\d{2}-\d{2})\s+(\S+)/.exec(cell);
  if (!match) return { ok: false, claimed: true, why: `"${cell}" is neither "No" nor "<date> <evidence path>"` };
  return exists(match[2]) ? { ok: true, claimed: true } : { ok: false, claimed: true, why: `evidence file ${match[2]} does not exist` };
}

function printMatrix() {
  const file = path.join(root, 'docs', 'integrations.md');
  if (!existsSync(file)) return { printed: false, problems: ['docs/integrations.md is missing'] };
  const rows = parseEvidenceMatrix(readFileSync(file, 'utf8'));
  const problems = [];
  console.log('\nIntegration evidence matrix (docs/integrations.md)');
  const width = Math.max(...rows.map((r) => r.integration.length), 11);
  console.log(`${'Integration'.padEnd(width)}  Implemented | Fixture-tested | Demo-verified | Live-verified`);
  for (const row of rows) {
    const live = checkLiveEvidence(row);
    if (!live.ok) problems.push(`${row.integration}: ${live.why}`);
    console.log(`${row.integration.padEnd(width)}  ${row.implemented} | ${row.fixtureTested} | ${row.demoVerified} | ${row.liveVerified}${live.ok ? '' : '  <-- INVALID'}`);
  }
  const unverified = rows.filter((r) => /^no\b/i.test(r.liveVerified)).length;
  console.log(`${unverified} of ${rows.length} integrations are not live-verified (that needs real credentials and a person's authorization; plan section 13).`);
  return { printed: true, problems, rows: rows.length, unverified };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const results = [];
  let failed = false;
  for (const step of STEPS) {
    const selected = (opts.only === null || opts.only.has(step.id)) && !opts.skip.has(step.id);
    if (!selected) {
      results.push({ id: step.id, title: step.title, status: 'SKIPPED' });
      continue;
    }
    if (failed && !opts.keepGoing) {
      results.push({ id: step.id, title: step.title, status: 'NOT RUN' });
      continue;
    }
    console.log(`\n=== ${step.id}: ${step.title}`);
    const outcome = await runStep(step);
    const passed = outcome.code === 0;
    if (!passed) failed = true;
    results.push({ id: step.id, title: step.title, status: passed ? 'PASSED' : 'FAILED', exitCode: outcome.code, seconds: Math.round(outcome.ms / 1000) });
  }

  if (!results.some((r) => r.status === 'PASSED' || r.status === 'FAILED')) {
    console.error('\nNo step ran (check --only / --skip). Nothing was verified.');
    failed = true;
  }

  const matrix = printMatrix();
  if (matrix.problems.length > 0) failed = true;

  const outDir = path.join(root, 'test-results');
  mkdirSync(outDir, { recursive: true });
  const summary = { finishedAt: new Date().toISOString(), node: process.version, steps: results, matrix, ok: !failed };
  writeFileSync(path.join(outDir, 'verify-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log('\nVerify summary');
  for (const r of results) console.log(`  ${r.status.padEnd(8)} ${r.id.padEnd(10)} ${r.title}${r.seconds === undefined ? '' : ` (${r.seconds}s)`}`);
  for (const p of matrix.problems) console.log(`  MATRIX   ${p}`);
  const skipped = results.filter((r) => r.status === 'SKIPPED' || r.status === 'NOT RUN');
  if (!failed && skipped.length > 0) console.log(`  Not a full verification: ${skipped.map((r) => r.id).join(', ')} did not run.`);
  console.log(failed ? '\nVERIFY FAILED' : skipped.length > 0 ? '\nVERIFY PASSED (partial run)' : '\nVERIFY PASSED');
  process.exitCode = failed ? 1 : 0;
}

// Compare real paths so a symlinked or junctioned checkout still runs main().
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) await main();
