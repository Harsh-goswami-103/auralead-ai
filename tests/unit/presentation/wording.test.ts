/**
 * ADR-126 / ADR-118 (slice F6): the product finds businesses through Google's Places API and
 * collects them from the Maps extension; its screens never call that data "scraped", which would
 * undercut the "licensed API, no scraping" line of the presentation. Checked on the source of the
 * landing components and the operator pages that describe lead sources.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const OPERATOR_PAGES = [
  'src/app/dashboard/employee/[ws]/leads/simulation-panel.tsx',
  'src/app/dashboard/employee/[ws]/extension/page.tsx',
  'src/app/dashboard/employee/[ws]/integrations/page.tsx',
];
const LANDING = readdirSync(path.join(ROOT, 'src/components/landing'))
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => `src/components/landing/${f}`);

describe('no "scraped" wording on screen', () => {
  it.each([...OPERATOR_PAGES, ...LANDING])('%s', (file) => {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    expect(source).not.toMatch(/scrap/i);
  });

  it('keeps describing the extension source in plain words', () => {
    const panel = readFileSync(path.join(ROOT, OPERATOR_PAGES[0]!), 'utf8');
    expect(panel).toMatch(/Maps extension/);
    const extension = readFileSync(path.join(ROOT, OPERATOR_PAGES[1]!), 'utf8');
    expect(extension).toMatch(/collected with the Google Maps extension/);
  });
});

/**
 * Adversarial review: since the template studio (ADR-123) templates are also written and submitted
 * in the app. Screens must not say they come only from WhatsApp Manager.
 */
describe('template wording after the studio (ADR-123)', () => {
  const STALE = [/Templates come from WhatsApp Manager/i, /Authored and approved in WhatsApp Manager/i, /synced from WhatsApp Manager once/i, /templates come from WhatsApp Manager, never authored here/i];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) files.push(rel);
    }
  };
  walk('src/components');
  walk('src/server/services');
  walk('src/app/dashboard');
  it('no screen string says templates come only from WhatsApp Manager', () => {
    const hits = files.filter((f) => STALE.some((re) => re.test(readFileSync(path.join(ROOT, f), 'utf8'))));
    expect(hits).toEqual([]);
  });
});
