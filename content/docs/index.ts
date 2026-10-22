/**
 * The documentation pages in sidebar order (plan T37, ADR-90). Adding a page: write it under
 * ./pages, add it here, and tests/unit/docs/content.test.ts checks its ids, links and every
 * command, env key, path, route and code it names.
 * A LIVE process shows only the pages, sections and blocks that apply to LIVE (ADR-116); a DEMO
 * process, a development opt-in, shows everything with its Applies to tags. Without a mode the
 * helpers see every page (the content tests).
 */
import type { DocMode, DocPage } from './format';
import { dataAndPrivacy } from './pages/data-and-privacy';
import { gettingStarted } from './pages/getting-started';
import { goingLive } from './pages/going-live';
import { leadToQuoteWorkflow } from './pages/lead-to-quote-workflow';
import { limitations } from './pages/limitations';
import { messagingRules } from './pages/messaging-rules';
import { rolesAndPanels } from './pages/roles-and-panels';
import { security } from './pages/security';
import { troubleshooting } from './pages/troubleshooting';

export const DOC_PAGES: readonly DocPage[] = [
  gettingStarted,
  goingLive,
  rolesAndPanels,
  leadToQuoteWorkflow,
  messagingRules,
  security,
  dataAndPrivacy,
  troubleshooting,
  limitations,
];

const applies = (modes: readonly DocMode[] | undefined, mode: DocMode) => modes === undefined || modes.includes(mode);

/** The page as `mode` shows it: sections and blocks for other modes left out. */
function pageForMode(page: DocPage, mode: DocMode): DocPage {
  return {
    ...page,
    sections: page.sections
      .filter((s) => applies(s.appliesTo, mode))
      .map((s) => ({ ...s, blocks: s.blocks.filter((b) => applies(b.appliesTo, mode)) }))
      .filter((s) => s.blocks.length > 0),
  };
}

const LIVE_PAGES: readonly DocPage[] = DOC_PAGES.filter((p) => p.appliesTo.includes('LIVE')).map((p) => pageForMode(p, 'LIVE'));

/** The pages a process in `mode` shows, in sidebar order. */
export function docPagesFor(mode: DocMode): readonly DocPage[] {
  return mode === 'LIVE' ? LIVE_PAGES : DOC_PAGES;
}

const pagesOf = (mode?: DocMode) => (mode ? docPagesFor(mode) : DOC_PAGES);

export function getDocPage(slug: string, mode?: DocMode): DocPage | undefined {
  return pagesOf(mode).find((p) => p.slug === slug);
}

/** The pages before and after `slug` in sidebar order. */
export function docNeighbours(slug: string, mode?: DocMode): { previous: DocPage | undefined; next: DocPage | undefined } {
  const pages = pagesOf(mode);
  const i = pages.findIndex((p) => p.slug === slug);
  if (i === -1) return { previous: undefined, next: undefined };
  return { previous: pages[i - 1], next: pages[i + 1] };
}
