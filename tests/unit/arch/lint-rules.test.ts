/**
 * Runs the project's real eslint.config.mjs through the ESLint Node API on fixture snippets
 * placed at virtual paths, proving each architectural rule fires where it should and only there.
 */
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
// Fixture paths do not exist on disk, so the type-aware parser service cannot find them.
// Only the typed rule is switched off; every rule under test here is syntactic.
const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfig: {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parserOptions: { projectService: false, project: null } },
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
});

type Hit = { ruleId: string | null; message: string };

async function lint(relPath: string, code: string): Promise<Hit[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, relPath) });
  if (!result) throw new Error('no lint result');
  const fatal = result.messages.filter((m) => m.fatal);
  if (fatal.length) throw new Error(`parse error in fixture: ${fatal.map((m) => m.message).join('; ')}`);
  return result.messages.filter((m) => m.severity === 2).map((m) => ({ ruleId: m.ruleId, message: m.message }));
}

const has = (hits: Hit[], pattern: RegExp) => hits.some((h) => pattern.test(h.message));

describe('clock rule: Date.now() and argument-less new Date()', () => {
  const code = `export function f(): number {\n  const a = Date.now();\n  const b = new Date();\n  return a + b.getTime();\n}\n`;

  it('is an error in src/server/** and worker/**', async () => {
    for (const file of ['src/server/services/leads/ingest.ts', 'worker/fixture.ts']) {
      const hits = await lint(file, code);
      expect(hits.filter((h) => /clock/i.test(h.message)), file).toHaveLength(2);
    }
  });

  it('allows new Date(value) in server code', async () => {
    const hits = await lint('src/server/services/x.ts', `export const d = (iso: string): Date => new Date(iso);\n`);
    expect(has(hits, /clock/i)).toBe(false);
  });

  it('does not apply outside server and worker code', async () => {
    expect(has(await lint('src/lib/clock.ts', code), /clock/i)).toBe(false);
    expect(has(await lint('scripts/fixture.ts', code), /clock/i)).toBe(false);
  });
});

describe('framework imports in server core', () => {
  it('next/headers and server-only are errors in services, adapters, jobs, security, pdf', async () => {
    for (const dir of ['services', 'adapters', 'jobs', 'security', 'pdf']) {
      const hits = await lint(
        `src/server/${dir}/fixture.ts`,
        `import 'server-only';\nimport { headers } from 'next/headers';\nexport const h = headers;\n`,
      );
      expect(hits.filter((h) => h.ruleId === 'no-restricted-imports'), dir).toHaveLength(2);
    }
  });

  it('server-only stays allowed in src/server/auth/session.ts', async () => {
    const hits = await lint('src/server/auth/session.ts', `import 'server-only';\nexport const x = 1;\n`);
    expect(hits.filter((h) => h.ruleId === 'no-restricted-imports')).toEqual([]);
  });

  it('adapters cannot import services', async () => {
    const hits = await lint(
      'src/server/adapters/email/resend.ts',
      `import { send } from '@/server/services/messaging/dispatch';\nexport const s = send;\n`,
    );
    expect(hits.some((h) => h.ruleId === 'no-restricted-imports')).toBe(true);
  });

  it('src/lib cannot import Next, Prisma or server code', async () => {
    const hits = await lint(
      'src/lib/fixture.ts',
      `import { cookies } from 'next/headers';\nimport { db } from '@/server/db/client';\nimport type { PrismaClient } from '@/generated/prisma/client';\nexport const all = [cookies, db] as const;\nexport type P = PrismaClient;\n`,
    );
    expect(hits.filter((h) => h.ruleId === 'no-restricted-imports')).toHaveLength(3);
  });

  it('UI code cannot import the DB layer', async () => {
    const hits = await lint('src/app/fixture.tsx', `import { db } from '@/server/db/client';\nexport const x = db;\n`);
    expect(hits.some((h) => h.ruleId === 'no-restricted-imports')).toBe(true);
  });
});

describe('UI rules in src/app and src/components', () => {
  it('empty event handlers are errors', async () => {
    const hits = await lint(
      'src/components/patterns/Fixture.tsx',
      `export function A() {\n  return <button type="button" onClick={() => {}}>x</button>;\n}\nexport function B() {\n  return <input onChange={function () {}} />;\n}\n`,
    );
    expect(hits.filter((h) => /empty .*handler/i.test(h.message))).toHaveLength(2);
  });

  it('a handler with a body is fine', async () => {
    const hits = await lint(
      'src/app/fixture/page.tsx',
      `export default function P({ go }: { go: () => void }) {\n  return <button type="button" onClick={() => go()}>x</button>;\n}\n`,
    );
    expect(has(hits, /empty .*handler/i)).toBe(false);
  });

  it('dangerouslySetInnerHTML is an error', async () => {
    const hits = await lint(
      'src/app/fixture/page.tsx',
      `export default function P({ html }: { html: string }) {\n  return <div dangerouslySetInnerHTML={{ __html: html }} />;\n}\n`,
    );
    expect(has(hits, /dangerouslySetInnerHTML/)).toBe(true);
  });

  it('glow utilities are errors outside src/components/visual/**', async () => {
    const code = `export function G() {\n  return <div className="rounded shadow-[0_0_24px_rgba(0,0,0,0.4)]"><span className={\`drop-shadow-lg\`}>x</span></div>;\n}\n`;
    expect((await lint('src/components/ui/Fixture.tsx', code)).filter((h) => /glow/i.test(h.message))).toHaveLength(2);
    expect((await lint('src/app/fixture/page.tsx', code)).filter((h) => /glow/i.test(h.message))).toHaveLength(2);
    expect(has(await lint('src/components/visual/HeroFixture.tsx', code), /glow/i)).toBe(false);
  });

  it('TODO comments and "coming soon" copy are errors', async () => {
    const hits = await lint(
      'src/components/patterns/Fixture.tsx',
      `// TODO wire this up\nexport function C() {\n  return <p>Coming soon</p>;\n}\nexport const label = 'Feature coming soon';\n`,
    );
    expect(hits.some((h) => h.ruleId === 'no-warning-comments')).toBe(true);
    expect(hits.filter((h) => /coming soon/i.test(h.message))).toHaveLength(2);
  });

  it('a clean component passes with no errors', async () => {
    const hits = await lint(
      'src/components/patterns/Clean.tsx',
      `export function Clean({ label }: { label: string }) {\n  return <p className="text-sm">{label}</p>;\n}\n`,
    );
    expect(hits).toEqual([]);
  });
});
