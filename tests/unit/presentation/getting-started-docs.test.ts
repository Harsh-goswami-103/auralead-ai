/**
 * ADR-126 (slice F6): the in-app "Run the demo locally" page describes the DEMO seed as it is. Its
 * identities table has one row per role-switcher persona, in the switcher's order, naming the
 * seeded person, the panel path and the workspaces the person owns; the paragraph after it counts
 * and names every seeded business. A persona or workspace added to the seed fails here until the
 * page says so.
 */
import { describe, expect, it } from 'vitest';
import { inlineText, parseInline, type DocBlock } from '@content/docs/format';
import { getDocPage } from '@content/docs/index';
import { DEMO_PERSONAS } from '@/server/auth/demo-personas';
import { MEMBERSHIP_FIXTURES, USER_FIXTURES } from '../../../prisma/seed/fixtures/identities';
import { WORKSPACE_FIXTURES } from '../../../prisma/seed/fixtures/workspaces';

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'] as const;

const page = getDocPage('getting-started');
if (!page) throw new Error('no docs page getting-started');
const blocks: DocBlock[] = page.sections.flatMap((s) => [...s.blocks]);
const plain = (s: string) => inlineText(parseInline(s)).replace(/\s+/g, ' ');
const paragraphs = blocks.filter((b): b is Extract<DocBlock, { kind: 'paragraph' }> => b.kind === 'paragraph').map((b) => plain(b.text));

describe('getting started: seeded identities', () => {
  const table = blocks.find((b): b is Extract<DocBlock, { kind: 'table' }> => b.kind === 'table' && b.caption === 'Seeded identities');
  const personas = Object.values(DEMO_PERSONAS);

  it('has one row per DEMO persona, in the switcher order', () => {
    expect(table).toBeDefined();
    expect(table!.rows.map((r) => plain(r[0]!))).toEqual(personas.map((p) => p.label));
    expect(paragraphs.some((p) => p.includes(`lists ${NUMBER_WORDS[personas.length]} seeded identities`))).toBe(true);
  });

  it.each(Object.entries(DEMO_PERSONAS))('names the seeded person, the panel and the owned workspaces of %s', (key, persona) => {
    const row = table!.rows.find((r) => plain(r[0]!) === persona.label)!;
    const user = USER_FIXTURES.find((u) => u.email === persona.email);
    expect(user, key).toBeDefined();
    expect(plain(row[1]!)).toContain(user!.name);
    expect(plain(row[2]!)).toContain(persona.home);
    for (const m of MEMBERSHIP_FIXTURES.filter((x) => x.user === user!.key && x.role === 'OWNER')) {
      expect(plain(row.join(' ')), m.workspace).toContain(WORKSPACE_FIXTURES.find((w) => w.slug === m.workspace)!.name);
    }
  });
});

describe('getting started: seeded businesses', () => {
  it('counts and names every seeded business with its city', () => {
    const seed = paragraphs.find((p) => p.startsWith('The seed holds'));
    expect(seed).toBeDefined();
    expect(seed).toContain(`The seed holds ${NUMBER_WORDS[WORKSPACE_FIXTURES.length]} invented businesses`);
    for (const ws of WORKSPACE_FIXTURES) {
      expect(seed).toContain(ws.name);
      expect(seed).toContain(ws.city);
    }
  });
});
