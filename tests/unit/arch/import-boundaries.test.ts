/**
 * Walks the real import graph (plan §3 "Import rules") and fails on any edge that crosses a
 * forbidden boundary. The checker itself is exercised on synthetic fixtures first so a green
 * run over the repo means "no violations", not "the walker found nothing".
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const SOURCE_EXT = /\.(ts|tsx|mts|mjs|js)$/;
const WALK_ROOTS = ['src', 'worker', 'scripts', 'prisma'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'generated', 'migrations']);
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.tsx'];

type Edge = { from: string; spec: string; target: string };
type Violation = Edge & { rule: string };

function walk(dirRel: string, out: string[]): void {
  const abs = path.join(repoRoot, dirRel);
  if (!existsSync(abs)) return;
  for (const name of readdirSync(abs)) {
    if (SKIP_DIRS.has(name)) continue;
    const rel = `${dirRel}/${name}`;
    const st = statSync(path.join(repoRoot, rel));
    if (st.isDirectory()) walk(rel, out);
    else if (SOURCE_EXT.test(name) && !name.endsWith('.d.ts')) out.push(rel);
  }
}

function listRepoFiles(): string[] {
  const out: string[] = [];
  for (const root of WALK_ROOTS) walk(root, out);
  for (const name of readdirSync(repoRoot)) {
    if (SOURCE_EXT.test(name) && statSync(path.join(repoRoot, name)).isFile()) out.push(name);
  }
  return out.sort();
}

function importSpecifiers(source: string): string[] {
  const info = ts.preProcessFile(source, true, true);
  return info.importedFiles.map((f) => f.fileName);
}

/** Resolves a specifier to a repo-relative posix path, or returns the bare package name. */
function resolveTarget(from: string, spec: string, exists: (rel: string) => boolean): string {
  let base: string | null = null;
  if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith('./') || spec.startsWith('../')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  if (base === null) return spec;
  for (const suffix of RESOLVE_SUFFIXES) {
    if (exists(base + suffix)) return base + suffix;
  }
  return base;
}

function buildEdges(files: Map<string, string>, exists: (rel: string) => boolean): Edge[] {
  const edges: Edge[] = [];
  for (const [from, source] of files) {
    for (const spec of importSpecifiers(source)) edges.push({ from, spec, target: resolveTarget(from, spec, exists) });
  }
  return edges;
}

const isPkg = (target: string, names: string[]) =>
  names.some((n) => target === n || target.startsWith(`${n}/`));
const under = (p: string, dirs: string[]) => dirs.some((d) => p === d || p.startsWith(`${d}/`));

const NEXT_PKGS = ['next', 'server-only'];
const DB_PKGS = ['@prisma/client', '@prisma/adapter-better-sqlite3', 'better-sqlite3'];
const DB_ALLOWED_IMPORTERS = ['src/server', 'worker', 'prisma/seed', 'prisma.config.ts', 'scripts', 'tests'];
const FRAMEWORK_FREE_SERVER = ['src/server/services', 'src/server/adapters', 'src/server/jobs', 'src/server/security', 'src/server/pdf'];

function checkEdges(edges: Edge[]): Violation[] {
  const v: Violation[] = [];
  for (const e of edges) {
    const { from, target } = e;
    if (under(from, ['src/lib'])) {
      if (under(target, ['src/server', 'src/app', 'src/generated', 'src/components'])) v.push({ ...e, rule: 'lib-imports-app-or-server' });
      if (isPkg(target, [...NEXT_PKGS, ...DB_PKGS, '@prisma'])) v.push({ ...e, rule: 'lib-imports-framework' });
    }
    if (under(from, FRAMEWORK_FREE_SERVER) && isPkg(target, NEXT_PKGS)) v.push({ ...e, rule: 'server-core-imports-next' });
    const isDbTarget = under(target, ['src/generated/prisma', 'src/server/db']) || isPkg(target, DB_PKGS);
    if (isDbTarget && !under(from, DB_ALLOWED_IMPORTERS)) v.push({ ...e, rule: 'db-imported-outside-server' });
    if (under(from, ['src/server/adapters']) && under(target, ['src/server/services'])) v.push({ ...e, rule: 'adapter-imports-service' });
  }
  return v;
}

function checkFixture(files: Record<string, string>): string[] {
  const map = new Map(Object.entries(files));
  return checkEdges(buildEdges(map, (rel) => map.has(rel))).map((x) => `${x.rule}:${x.from}`);
}

describe('import boundary checker (fixtures)', () => {
  it('flags src/lib importing server, app, next, server-only or Prisma', () => {
    const found = checkFixture({
      'src/lib/a.ts': `import { x } from '@/server/auth/session';`,
      'src/lib/b.ts': `import { headers } from 'next/headers';`,
      'src/lib/c.ts': `import 'server-only';`,
      'src/lib/d.ts': `import type { PrismaClient } from '@/generated/prisma/client';`,
      'src/lib/e.ts': `export { y } from '../app/page';`,
      'src/lib/f.ts': `const m = await import('@prisma/client');`,
      'src/server/auth/session.ts': '',
      'src/app/page.tsx': '',
    });

    expect(found).toEqual(
      expect.arrayContaining([
        'lib-imports-app-or-server:src/lib/a.ts',
        'lib-imports-framework:src/lib/b.ts',
        'lib-imports-framework:src/lib/c.ts',
        'lib-imports-app-or-server:src/lib/d.ts',
        'lib-imports-app-or-server:src/lib/e.ts',
        'lib-imports-framework:src/lib/f.ts',
      ]),
    );
  });

  it('flags next/* and server-only in services, adapters, jobs, security and pdf', () => {
    const found = checkFixture({
      'src/server/services/leads/ingest.ts': `import { cookies } from 'next/headers';`,
      'src/server/jobs/queue.ts': `import 'server-only';`,
      'src/server/pdf/render.ts': `import { NextResponse } from 'next/server';`,
      'src/server/auth/session.ts': `import 'server-only';`,
    });

    expect(found.sort()).toEqual([
      'server-core-imports-next:src/server/jobs/queue.ts',
      'server-core-imports-next:src/server/pdf/render.ts',
      'server-core-imports-next:src/server/services/leads/ingest.ts',
    ]);
  });

  it('flags DB access outside server, worker, seed, scripts and tests', () => {
    const found = checkFixture({
      'src/app/page.tsx': `import { db } from '@/server/db/client';`,
      'src/components/x.tsx': `import { PrismaClient } from '@/generated/prisma/client';`,
      'src/server/services/a.ts': `import { db } from '../db/client';`,
      'worker/index.ts': `import { db } from '../src/server/db/client';`,
      'scripts/db-path.ts': `import { db } from '@/server/db/client';`,
      'src/server/db/client.ts': '',
    });

    expect(found.sort()).toEqual(['db-imported-outside-server:src/app/page.tsx', 'db-imported-outside-server:src/components/x.tsx']);
  });

  it('flags adapters importing services', () => {
    const found = checkFixture({
      'src/server/adapters/whatsapp/cloud-api.ts': `import { x } from '../../services/messaging/dispatch';`,
      'src/server/services/messaging/dispatch.ts': `import { y } from '@/server/adapters/registry';`,
      'src/server/adapters/registry.ts': '',
    });

    expect(found).toEqual(['adapter-imports-service:src/server/adapters/whatsapp/cloud-api.ts']);
  });
});

describe('import boundaries (real repo graph)', () => {
  const files = listRepoFiles();
  const sources = new Map(files.map((f) => [f, readFileSync(path.join(repoRoot, f), 'utf8')]));

  it('walks the files that exist so far', () => {
    expect(files).toEqual(expect.arrayContaining(['src/lib/env-load.ts', 'src/lib/config.ts', 'src/lib/paths.ts', 'scripts/setup.ts']));
  });

  it('has no boundary violations', () => {
    const edges = buildEdges(sources, (rel) => existsSync(path.join(repoRoot, rel)) && statSync(path.join(repoRoot, rel)).isFile());
    expect(edges.length).toBeGreaterThan(0);
    expect(checkEdges(edges)).toEqual([]);
  });

  it('APP_MODE is read only in src/lib/config.ts and src/server/adapters/registry.ts', () => {
    const allowed = new Set(['src/lib/config.ts', 'src/server/adapters/registry.ts']);
    const offenders = [...sources]
      .filter(([f, src]) => !allowed.has(f) && /(?<![A-Z_])APP_MODE\b/.test(src))
      .map(([f]) => f);

    expect(offenders).toEqual([]);
  });
});
