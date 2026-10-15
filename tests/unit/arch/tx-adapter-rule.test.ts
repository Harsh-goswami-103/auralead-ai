/**
 * Plan §3 import rules: "Adapter imports are banned inside withTx callbacks (no `adapters/`
 * symbols, no `await` of network calls)". A provider call inside a transaction would hold the
 * SQLite write lock across the network and break the outbox ordering (plan §4.4). Runs the real
 * eslint.config.mjs on fixture snippets at virtual paths, like lint-rules.test.ts.
 */
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfig: {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parserOptions: { projectService: false, project: null } },
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
});

async function txHits(relPath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, relPath) });
  if (!result) throw new Error('no lint result');
  const fatal = result.messages.filter((m) => m.fatal);
  if (fatal.length) throw new Error(`parse error in fixture: ${fatal.map((m) => m.message).join('; ')}`);
  return result.messages.filter((m) => m.ruleId === 'auralead/no-adapter-in-tx').map((m) => m.message);
}

const ADAPTER_IN_TX = `import { withTx } from '@/server/db/tx';
import { createDemoWhatsAppTransport } from '@/server/adapters/whatsapp/demo';
export async function f(db: never, outbox: never, clock: never) {
  return withTx(db, async (tx) => {
    const t = createDemoWhatsAppTransport(outbox, clock);
    return t;
  });
}
`;

const NETWORK_IN_TX = `import { request } from 'undici';
import { safeFetch } from '@/server/security/safe-fetch';
export async function g(ctx: { fencedTx: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> }) {
  await ctx.fencedTx(async () => {
    await fetch('https://example.com');
    await request('https://example.com');
    await safeFetch('https://example.com');
  });
}
`;

const RELATIVE_ADAPTER_IN_TRANSACTION = `import { outboundRequest } from '../../adapters/http/outbound';
export async function h(db: { $transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> }, at: Date) {
  await db.$transaction(async () => outboundRequest('live', 'https://x.test', { method: 'GET' }, at));
}
`;

const OUTSIDE_TX = `import { withTx } from '@/server/db/tx';
import { createDemoWhatsAppTransport } from '@/server/adapters/whatsapp/demo';
import type { SendOutcome } from '@/server/adapters/whatsapp/port';
export async function ok(db: never, outbox: never, clock: never): Promise<SendOutcome> {
  const plan = await withTx(db, async (tx) => {
    const typed: SendOutcome | null = null;
    return { tx, typed };
  });
  const outcome = await createDemoWhatsAppTransport(outbox, clock).send(plan as never);
  await withTx(db, async () => outcome);
  return outcome;
}
`;

describe('no adapter or network calls inside transaction callbacks', () => {
  it('flags an adapter symbol used inside withTx', { timeout: 30_000 }, async () => {
    const hits = await txHits('src/server/services/messaging/fixture.ts', ADAPTER_IN_TX);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/adapter/i);
  });

  it('flags fetch, undici request and safeFetch inside fencedTx', { timeout: 30_000 }, async () => {
    const hits = await txHits('src/server/jobs/handlers/fixture.ts', NETWORK_IN_TX);
    expect(hits).toHaveLength(3);
    expect(hits.every((m) => /network/i.test(m))).toBe(true);
  });

  it('flags a relative adapter import used inside $transaction', { timeout: 30_000 }, async () => {
    expect(await txHits('src/server/services/x/fixture.ts', RELATIVE_ADAPTER_IN_TRANSACTION)).toHaveLength(1);
  });

  it('allows adapter calls outside the callback and type-only adapter imports inside it', { timeout: 30_000 }, async () => {
    expect(await txHits('src/server/jobs/handlers/fixture.ts', OUTSIDE_TX)).toEqual([]);
  });

  it('applies to worker code too', { timeout: 30_000 }, async () => {
    expect(await txHits('worker/fixture.ts', ADAPTER_IN_TX)).toHaveLength(1);
  });

  it('the production server and worker code passes the rule', { timeout: 120_000 }, async () => {
    const results = await new ESLint({ cwd: repoRoot }).lintFiles(['src/server/**/*.ts', 'worker/**/*.ts']);
    const hits = results.flatMap((r) => r.messages.filter((m) => m.ruleId === 'auralead/no-adapter-in-tx').map((m) => `${r.filePath}:${m.line} ${m.message}`));
    expect(hits).toEqual([]);
  });
});
