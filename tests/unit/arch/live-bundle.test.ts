/**
 * Plan §4.2, ADR-04, P19 / R35: in LIVE the role switcher is absent from the bundle, not merely
 * hidden. The only way into the RoleSwitcher module is the gate in DemoChrome.tsx, which loads it
 * through a dynamic import guarded by the build-time constant NEXT_PUBLIC_APP_MODE. This test
 * bundles the gate with a real bundler (Vite 8 / Rolldown) twice: with the constant set to
 * "live" the RoleSwitcher module and its marker must be gone; with "demo" they must be present.
 * It also walks src/ to prove nothing else imports the RoleSwitcher module.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { build, type Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';
import { DEMO_PERSONA_KEYS, DEMO_PERSONAS } from '@/server/auth/demo-personas';
import { SWITCHER_PERSONAS } from '@/components/patterns/RoleSwitcher';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src');
const GATE = path.join(SRC, 'components', 'patterns', 'DemoChrome.tsx');
const SWITCHER = path.join(SRC, 'components', 'patterns', 'RoleSwitcher.tsx');
const MARKER = 'data-demo-role-switcher';

type Bundle = { code: string; moduleIds: string[] };

async function bundleGate(mode: 'demo' | 'live'): Promise<Bundle> {
  const result = await build({
    configFile: false,
    envDir: false,
    root: ROOT,
    logLevel: 'silent',
    resolve: { alias: [{ find: /^@\//, replacement: `${SRC.replaceAll('\\', '/')}/` }] },
    define: { 'process.env.NEXT_PUBLIC_APP_MODE': JSON.stringify(mode) },
    build: {
      write: false,
      minify: false,
      lib: { entry: GATE, formats: ['es'], fileName: 'gate' },
      rolldownOptions: {
        // Bundle only our own source; every package (react, next/dynamic, radix, ...) is external.
        external: (id: string) => !id.startsWith('.') && !id.startsWith('@/') && !path.isAbsolute(id) && !id.startsWith('\0'),
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  const chunks = outputs.flatMap((o) => o.output).filter((c): c is Rolldown.OutputChunk => c.type === 'chunk');
  return {
    code: chunks.map((c) => c.code).join('\n'),
    moduleIds: chunks.flatMap((c) => c.moduleIds).map((id) => path.normalize(id)),
  };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'generated') walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function resolveSpecifier(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.normalize(candidate);
  }
  return null;
}

describe('LIVE bundle excludes the role switcher', () => {
  it('LIVE: the gate bundle contains neither the RoleSwitcher module nor its marker', async () => {
    const live = await bundleGate('live');
    expect(live.moduleIds.some((id) => id === path.normalize(GATE))).toBe(true);
    expect(live.moduleIds).not.toContain(path.normalize(SWITCHER));
    expect(live.code).not.toContain(MARKER);
    expect(live.code).not.toContain('/api/demo/session');
  }, 60_000);

  it('DEMO: the same gate bundles the RoleSwitcher module (the check is not vacuous)', async () => {
    const demo = await bundleGate('demo');
    expect(demo.moduleIds).toContain(path.normalize(SWITCHER));
    expect(demo.code).toContain(MARKER);
    expect(demo.code).toContain('/api/demo/session');
  }, 60_000);

  it('only DemoChrome.tsx imports the RoleSwitcher module', () => {
    const importers: string[] = [];
    for (const file of walk(SRC)) {
      const info = ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true);
      for (const ref of info.importedFiles) {
        if (resolveSpecifier(file, ref.fileName) === path.normalize(SWITCHER)) importers.push(path.relative(ROOT, file).replaceAll('\\', '/'));
      }
    }
    expect([...new Set(importers)]).toEqual(['src/components/patterns/DemoChrome.tsx']);
  });

  it('the switcher offers exactly the server-side demo personas', () => {
    // Four personas: the presentation client (ADR-126) joined the three of T06.
    expect([...DEMO_PERSONA_KEYS]).toEqual(['user', 'client', 'employee', 'admin']);
    expect(SWITCHER_PERSONAS.map((p) => p.key)).toEqual([...DEMO_PERSONA_KEYS]);
    // e2e names the workspace owner by /^Workspace owner/: no other label may start with it.
    expect(SWITCHER_PERSONAS.filter((p) => p.label.startsWith('Workspace owner')).map((p) => p.key)).toEqual(['user']);
    for (const p of SWITCHER_PERSONAS) {
      expect(p.label).toBe(DEMO_PERSONAS[p.key].label);
      expect(p.home).toBe(DEMO_PERSONAS[p.key].home);
    }
  });
});
