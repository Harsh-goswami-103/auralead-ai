/**
 * Lead-gen anchor blocks (docs/handoff/lead-gen-suite-plan.md §6, docs/handoff/lead-gen-worktrees.md):
 * the six slices build in parallel worktrees and append to shared files only between their own
 * `// ---- lead-gen F<n> <name> ----` and `// ---- end F<n> ----` lines, so the merges never meet.
 * This pins that every anchor area still holds all six blocks in order, nothing nested or
 * misspelled, and that the routes a slice adds sit in its own block with its own manifest owner.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEAD_GEN_MANIFEST_OWNERS, LEAD_GEN_SLICES, leadGenAnchor, type LeadGenSlice } from '@/lib/domain/lead-gen';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

/** Shared file -> how many anchor areas it has (each area holds the six blocks F1..F6). */
const ANCHOR_AREAS: Readonly<Record<string, number>> = {
  'src/server/routes.manifest.ts': 1, // ROUTES
  'src/server/jobs/registry.ts': 2, // handler imports, JOB_DEFINITIONS
  'src/components/metrics/activity-vocabulary.ts': 1, // ACTIVITY_LABELS
  'src/server/adapters/registry.ts': 2, // adapter imports, resolvers at the end of the file
  'src/components/integrations/sections.ts': 2, // icon imports, WORKSPACE_SECTIONS
  'tests/support/routes.ts': 1, // MATRIX_FIXTURES
  'tests/unit/arch/registry-live.test.ts': 5, // imports, DEMO_MODULES, LIVE_MODULES, LIVE_FUNCTIONS, runtime cases at the end
};

type Marker = { line: number; slice: LeadGenSlice; edge: 'begin' | 'end' };

const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8').split(/\r?\n/);

function markers(rel: string): { markers: Marker[]; malformed: string[] } {
  const out: Marker[] = [];
  const malformed: string[] = [];
  read(rel).forEach((text, i) => {
    const trimmed = text.trim();
    if (!/----\s*(?:lead-gen\s+F\d|end\s+F\d)/i.test(trimmed)) return;
    for (const slice of LEAD_GEN_SLICES) {
      const anchor = leadGenAnchor(slice);
      if (trimmed === `// ${anchor.begin}`) return void out.push({ line: i + 1, slice, edge: 'begin' });
      if (trimmed === `// ${anchor.end}`) return void out.push({ line: i + 1, slice, edge: 'end' });
    }
    malformed.push(`${rel}:${i + 1}: ${trimmed}`);
  });
  return { markers: out, malformed };
}

/** [begin, end] line numbers of each slice's blocks, in file order. */
function blocks(rel: string): Array<{ slice: LeadGenSlice; begin: number; end: number }> {
  const m = markers(rel).markers;
  const out: Array<{ slice: LeadGenSlice; begin: number; end: number }> = [];
  for (let i = 0; i + 1 < m.length; i += 2) out.push({ slice: m[i]!.slice, begin: m[i]!.line, end: m[i + 1]!.line });
  return out;
}

describe('lead-gen anchor blocks in the shared files', () => {
  for (const [rel, areas] of Object.entries(ANCHOR_AREAS)) {
    it(`${rel}: ${areas} area(s), each F1..F6 in order, every block closed before the next opens`, () => {
      const { markers: found, malformed } = markers(rel);
      expect(malformed).toEqual([]);
      const expected = Array.from({ length: areas }, () => LEAD_GEN_SLICES.flatMap((slice) => [`${slice} begin`, `${slice} end`])).flat();
      expect(found.map((m) => `${m.slice} ${m.edge}`)).toEqual(expected);
    });
  }

  it('the manifest routes in a slice block carry that slice owner, and no lead-gen owner appears outside its block', () => {
    const rel = 'src/server/routes.manifest.ts';
    const lines = read(rel);
    const owners = new Map<number, string>();
    lines.forEach((text, i) => {
      const m = /\bowner:\s*'(T\d{2})'/.exec(text);
      if (m) owners.set(i + 1, m[1]!);
    });
    const leadGenOwners = new Set<string>(Object.values(LEAD_GEN_MANIFEST_OWNERS));
    const inBlock = new Set<number>();
    for (const block of blocks(rel)) {
      for (const [line, owner] of owners) {
        if (line <= block.begin || line >= block.end) continue;
        inBlock.add(line);
        expect(owner, `${rel}:${line} in the ${block.slice} block`).toBe(LEAD_GEN_MANIFEST_OWNERS[block.slice]);
      }
    }
    const strays = [...owners].filter(([line, owner]) => leadGenOwners.has(owner) && !inBlock.has(line)).map(([line, owner]) => `${rel}:${line} ${owner}`);
    expect(strays).toEqual([]);
  });
});
