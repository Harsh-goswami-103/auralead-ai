/**
 * Plan §3 and §10: the violet `--ai` token is reserved for AI provenance and AI mode, so it may be
 * used only in AI components (`src/components/ai/**`). Runs the real eslint.config.mjs on fixture
 * snippets at virtual paths, like lint-rules.test.ts.
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

async function aiHits(relPath: string, code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, relPath) });
  if (!result) throw new Error('no lint result');
  const fatal = result.messages.filter((m) => m.fatal);
  if (fatal.length) throw new Error(`parse error in fixture: ${fatal.map((m) => m.message).join('; ')}`);
  return result.messages.filter((m) => m.severity === 2 && /--ai/.test(m.message)).length;
}

const USES = `export function Chip({ on }: { on: boolean }) {
  const tone = \`rounded px-2 \${on ? 'hover:bg-ai/20' : ''}\`;
  return (
    <span className="text-ai border-ai/40" style={{ color: 'var(--ai)' }} data-tone={tone}>
      AI draft
    </span>
  );
}
`;

describe('--ai token rule', () => {
  it('is an error in app pages, patterns and visual components', { timeout: 30_000 }, async () => {
    for (const file of ['src/app/dashboard/user/page.tsx', 'src/components/patterns/StatusBadge.tsx', 'src/components/visual/HeroGlobe.tsx']) {
      expect(await aiHits(file, USES), file).toBe(3);
    }
  });

  it('is allowed in AI components', { timeout: 30_000 }, async () => {
    expect(await aiHits('src/components/ai/AiDraftCard.tsx', USES)).toBe(0);
  });

  it('does not fire on words that merely contain "ai"', { timeout: 30_000 }, async () => {
    const code = `export const C = () => <p className="text-fg-2 mt-4 rounded-md" title="email detail">Maintain your chair, said Kai.</p>;\n`;
    expect(await aiHits('src/app/dashboard/user/page.tsx', code)).toBe(0);
    expect(await aiHits('src/components/patterns/x.tsx', `export const k = ['bg-bg-2', 'text-cyan', 'detail-ai-x', 'mail'];\n`)).toBe(0);
  });
});
