/**
 * The documentation pages in sidebar order (plan T37, ADR-90). Adding a page: write it under
 * ./pages, add it here, and tests/unit/docs/content.test.ts checks its ids, links and every
 * command, env key, path, route and code it names.
 */
import type { DocPage } from './format';
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

export function getDocPage(slug: string): DocPage | undefined {
  return DOC_PAGES.find((p) => p.slug === slug);
}

/** The pages before and after `slug` in sidebar order. */
export function docNeighbours(slug: string): { previous: DocPage | undefined; next: DocPage | undefined } {
  const i = DOC_PAGES.findIndex((p) => p.slug === slug);
  if (i === -1) return { previous: undefined, next: undefined };
  return { previous: DOC_PAGES[i - 1], next: DOC_PAGES[i + 1] };
}
