/**
 * T37 (ADR-91): the honesty test for the documentation. The in-app pages (content/docs/**) and the
 * repo docs (README.md, docs/{architecture,deployment,runbooks}.md) may only name things that
 * exist in this repository:
 *  - structure: unique kebab-case slugs and anchor ids, "Applies to" on every page, a valid
 *    `checked` date, well-formed tables, no placeholder words;
 *  - links: every /docs link and #anchor resolves, every app path is a route in the manifest,
 *    every href passes safeHref, external links are https only;
 *  - code spans and code blocks: every `npm run <script>` is in package.json, every env key is in
 *    .env.example, every repo path exists, every app route is in the manifest, every UPPER_CASE
 *    code and dotted name (job types, audit actions, capabilities, file names) occurs in the code;
 *  - facts: the reason-code table, the Stop/Start keyword lists, the rate-limit table and the
 *    numbers quoted on the security, troubleshooting and data pages are compared with the
 *    constants the code uses, so a code change that makes a page wrong fails here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { describe, expect, it } from 'vitest';
import { DOC_MODES, inlineStrings, inlineText, pageAnchors, parseInline, type DocBlock, type DocPage, type InlineNode } from '@content/docs/format';
import { DOC_PAGES, docNeighbours, docPagesFor, getDocPage } from '@content/docs/index';
import { CAPABILITIES, type Capability } from '@/lib/domain/enums';
import { PROMOTIONAL_WORDS, STUDIO_CATEGORIES, TEMPLATE_LIMITS, UTILITY_TRIGGER_LABELS } from '@/lib/domain/template-authoring';
import { OPT_IN_METHOD_LABELS, OPT_IN_METHODS } from '@/lib/schemas/consent';
import {
  consentAttestationText,
  IMPORT_CONSENT_TRUTHY_VALUES,
  IMPORT_DATA_SOURCE_LABELS,
  IMPORT_FIELD_MAX_LENGTH,
  LEAD_IMPORT_CHUNK,
  LEAD_IMPORT_MAX_ROWS,
  LEAD_IMPORT_PREVIEW_ROWS,
  LEAD_IMPORT_TTL_HOURS,
} from '@/lib/schemas/lead-import';
import { LEAD_EXPORT_ROW_CAP, LEAD_EXPORT_TTL_HOURS } from '@/lib/schemas/leads';
import { MEDIA_PDF_MAX_BYTES } from '@/lib/schemas/templates';
import { SPREADSHEET_LIMITS } from '@/lib/spreadsheet/types';
import { DEMO_TEMPLATE_REVIEW_DELAY_MS } from '@/server/adapters/whatsapp/template-admin-demo';
import { DEMO_PERSONA_KEYS, DEMO_PERSONAS } from '@/server/auth/demo-personas';
import { MEMBER_CAPABILITIES } from '@/server/auth/guards';
import { INVITE_TTL_MS } from '@/server/auth/invites';
import { LOGIN_LOCKOUT } from '@/server/auth/login';
import { ARGON2_PARAMS, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/server/auth/password';
import { PASSWORD_RESET_TTL_MS } from '@/server/auth/password-reset';
import { SESSION_POLICY } from '@/server/auth/session';
import { ROUTES } from '@/server/routes.manifest';
import { RATE_LIMIT_POLICIES, type RateLimitPolicyName } from '@/server/security/rate-limit';
import { safeHref } from '@/server/security/safe-href';
import { CONVERSATION_HISTORY_LIMIT } from '@/server/services/ai/conversation-reply';
import { automatedReplyDisclosure, FIXED_REPLIES } from '@/server/services/ai/reply-guard';
import { MAX_EMAILS_PER_RESULT } from '@/server/services/lead-finder/email-extract';
import { EMAIL_PAGE_LIMITS } from '@/server/services/lead-finder/emails';
import { FINDER_EXPORT_ROW_CAP } from '@/server/services/lead-finder/export';
import { FINDER_CONTENT_TTL_MS } from '@/server/services/lead-finder/jobs';
import { FINDER_LIMITS } from '@/server/services/lead-finder/schemas';
import { PLACES_CONTENT_TTL_DAYS } from '@/server/services/leads/ingest';
import { LEAD_EXPORT_ACTIVE_CAP } from '@/server/services/leads/export';
import { AUTOMATED_REPLY_CAP } from '@/server/services/messaging/conversations';
import { DEFERRABLE_REASONS, REASON_LABELS, REASON_ORDER } from '@/server/services/messaging/eligibility';
import { START_KEYWORDS, STOP_KEYWORDS } from '@/server/services/messaging/quick-replies';
import { WORKER_STALE_AFTER_MS } from '@/server/services/shell/panel-home';
import { PROCESSED_RETENTION_MS, UNRESOLVED_RETENTION_MS } from '@/server/services/webhooks/events';
import { WORKSPACE_FIXTURES } from '../../../prisma/seed/fixtures/workspaces';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const SCRIPTS: Record<string, string> = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
const ENV_KEYS = new Set(Object.keys(parseEnv(read('.env.example'))));

function walk(rel: string, ext: RegExp, out: string[] = []): string[] {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    if (name === 'generated' || name === 'node_modules' || name === 'migrations') continue;
    const child = `${rel}/${name}`;
    if (statSync(path.join(ROOT, child)).isDirectory()) walk(child, ext, out);
    else if (ext.test(name)) out.push(child);
  }
  return out;
}

/** The code the docs describe: app, server, lib, worker, scripts, seed and schema. */
const CORPUS = [...walk('src', /\.tsx?$/), ...walk('worker', /\.ts$/), ...walk('scripts', /\.(ts|mjs)$/), ...walk('prisma', /\.(ts|prisma)$/)].map(read).join('\n');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const inCorpus = (word: string) => new RegExp(`(?<![A-Za-z0-9_])${escapeRe(word)}(?![A-Za-z0-9_])`).test(CORPUS);

const REQUIRED_SLUGS = [
  'getting-started',
  'going-live',
  'roles-and-panels',
  'lead-to-quote-workflow',
  'messaging-rules',
  'security',
  'data-and-privacy',
  'troubleshooting',
  'limitations',
];
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_IDS = new Set(['main', 'on-this-page']);
const ROOT_FILES = new Set([
  'README.md',
  'CLAUDE.md',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
  'package-lock.json',
  '.env.example',
  '.nvmrc',
  'next.config.ts',
  'prisma.config.ts',
  'tsconfig.json',
]);
const REPO_PATH = /^(?:src|docs|scripts|prisma|tests|content|worker)\//;
const FORBIDDEN = [/\bTODO\b/, /\bTBD\b/, /coming\s+soon/i, /lorem/i, /\bFIXME\b/];

// ---- helpers -----------------------------------------------------------------------------------

function nodesOf(page: DocPage): InlineNode[] {
  return inlineStrings(page).flatMap((s) => parseInline(s));
}

function collect(nodes: readonly InlineNode[], type: 'code' | 'link', out: InlineNode[] = []): InlineNode[] {
  for (const n of nodes) {
    if (n.type === type) out.push(n);
    if (n.type === 'strong' || n.type === 'link') collect(n.children, type, out);
  }
  return out;
}

const codeSpansOf = (nodes: readonly InlineNode[]) => collect(nodes, 'code').map((n) => (n as { value: string }).value);
const hrefsOf = (nodes: readonly InlineNode[]) => collect(nodes, 'link').map((n) => (n as { href: string }).href);

function blocksOf(page: DocPage): DocBlock[] {
  return page.sections.flatMap((s) => s.blocks);
}

function pageText(page: DocPage): string {
  const parts = inlineStrings(page).map((s) => inlineText(parseInline(s)));
  for (const b of blocksOf(page)) if (b.kind === 'code') parts.push(b.code);
  return parts.join(' ').replace(/\s+/g, ' ');
}

const isDynamic = (seg: string) => /^\[.+\]$/.test(seg);
const isPlaceholder = (seg: string) => /^<.+>$/.test(seg) || isDynamic(seg);
const ROUTE_SEGMENTS = ROUTES.map((r) => r.path.split('/').filter(Boolean));

/** An app path (`/login`, `/dashboard/employee/<ws>/leads`, `/api/app/*`) that the manifest serves. */
function routeExists(raw: string): boolean {
  const [pathname = ''] = raw.split(/[?#]/);
  if (pathname.endsWith('/*')) {
    const prefix = pathname.slice(0, -1);
    return ROUTES.some((r) => r.path.startsWith(prefix));
  }
  const segs = pathname.split('/').filter(Boolean);
  if (segs[0] === 'docs') return segs.length === 1 || (segs.length === 2 && getDocPage(segs[1]!) !== undefined);
  return ROUTE_SEGMENTS.some(
    (pattern) =>
      pattern.length === segs.length && pattern.every((p, i) => (isDynamic(p) ? true : p === segs[i])) && segs.every((s, i) => !isPlaceholder(s) || isDynamic(pattern[i]!)),
  );
}

function repoPathExists(raw: string): boolean {
  let p = raw.replace(/^\.\//, '');
  const cut = p.search(/[*<]/);
  if (cut !== -1) p = p.slice(0, cut);
  p = p.replace(/\/+$/, '');
  return p !== '' && existsSync(path.join(ROOT, p));
}

/** A shell command named in the docs: undefined when the text is not a command at all. */
function checkCommand(command: string): string | null | undefined {
  const c = command.trim();
  const run = /^npm run ([\w:.-]+)/.exec(c);
  if (run) return run[1]! in SCRIPTS ? null : `npm script "${run[1]}" is not in package.json`;
  if (c === 'npm ci') return null;
  if (/^npm\s/.test(c)) return `"${c}": only npm ci and npm run <script> are documented`;
  if (/^(?:npx|node|tsx|next|prisma)\s/.test(c)) return Object.values(SCRIPTS).includes(c) ? null : `"${c}" is not the command of a package.json script`;
  return undefined;
}

/**
 * Problems with one inline code span, or null when it names something real (or nothing checkable).
 * With `phrases`, a quoted message (a span with a space, or ending in a colon, that is not a
 * command, path or placeholder) must occur verbatim in the code, so a quoted error stays real.
 */
function checkCodeSpan(span: string, options: { phrases?: boolean } = {}): string | null {
  const s = span.trim();
  if (s.includes('\n')) return null;
  const command = checkCommand(s);
  if (command !== undefined) return command;
  if (options.phrases && (/\s/.test(s) || s.endsWith(':')) && !/^[-<%~$/.]/.test(s) && !CORPUS.includes(s)) return `message "${s}" does not occur in the code`;
  const assignment = /^([A-Z][A-Z0-9_]*[A-Z0-9])=(.*)$/.exec(s);
  if (assignment) return ENV_KEYS.has(assignment[1]!) ? null : `env key ${assignment[1]} is not in .env.example`;
  if (/^[A-Z][A-Z0-9_]*[A-Z0-9]$/.test(s) && s.length >= 3) return ENV_KEYS.has(s) || inCorpus(s) ? null : `code ${s} does not occur in the code`;
  if (ROOT_FILES.has(s) || REPO_PATH.test(s.replace(/^\.\//, ''))) return repoPathExists(s) ? null : `path ${s} does not exist`;
  if (/^\/[a-z]/.test(s) && !/\s/.test(s)) return routeExists(s) ? null : `route ${s} is not in the route manifest`;
  if (/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(s)) return inCorpus(s) ? null : `name ${s} does not occur in the code`;
  return null;
}

function checkCodeBlock(block: Extract<DocBlock, { kind: 'code' }>): string[] {
  const problems: string[] = [];
  for (const rawLine of block.code.split('\n')) {
    const line = rawLine.replace(/^\s*(?:\$|PS>)\s+/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    if (block.language === 'env') {
      const key = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
      if (!key) problems.push(`env block line "${line}" is not KEY=value`);
      else if (!ENV_KEYS.has(key)) problems.push(`env key ${key} is not in .env.example`);
      continue;
    }
    const command = checkCommand(line);
    if (command) problems.push(command);
  }
  return problems;
}

function checkLink(page: DocPage, href: string): string | null {
  if (safeHref(href) === null) return `href ${href} is refused by safeHref`;
  if (href.startsWith('#')) return pageAnchors(page).includes(href.slice(1)) ? null : `anchor ${href} is missing on ${page.slug}`;
  if (href === '/docs' || href.startsWith('/docs/') || href.startsWith('/docs#')) {
    const [pathname = '', fragment] = href.split('#');
    const segs = pathname.split('/').filter(Boolean);
    if (segs.length === 1) return fragment === undefined ? null : `the docs index has no anchors (${href})`;
    const target = segs.length === 2 ? getDocPage(segs[1]!) : undefined;
    if (!target) return `no docs page ${pathname}`;
    if (fragment !== undefined && !pageAnchors(target).includes(fragment)) return `anchor #${fragment} is missing on ${target.slug}`;
    return null;
  }
  if (href.startsWith('/')) return routeExists(href) && !/[[<]/.test(href) ? null : `route ${href} is not in the route manifest`;
  if (href.startsWith('https://')) return null;
  return `unsupported href ${href}`;
}

function tableWithHead(page: DocPage, first: string): Extract<DocBlock, { kind: 'table' }> {
  const table = blocksOf(page).find((b): b is Extract<DocBlock, { kind: 'table' }> => b.kind === 'table' && b.head[0] === first);
  if (!table) throw new Error(`${page.slug} has no table whose first column is "${first}"`);
  return table;
}

const page = (slug: string) => {
  const p = getDocPage(slug);
  if (!p) throw new Error(`no docs page ${slug}`);
  return p;
};

// ---- structure ---------------------------------------------------------------------------------

describe('docs content structure', () => {
  it('has every required page, in a stable order, with unique kebab-case slugs', () => {
    const slugs = DOC_PAGES.map((p) => p.slug);
    for (const slug of REQUIRED_SLUGS) expect(slugs).toContain(slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(KEBAB);
    expect(getDocPage('no-such-page')).toBeUndefined();
  });

  it('links each page to its neighbours in sidebar order', () => {
    DOC_PAGES.forEach((p, i) => {
      const { previous, next } = docNeighbours(p.slug);
      expect(previous?.slug).toBe(DOC_PAGES[i - 1]?.slug);
      expect(next?.slug).toBe(DOC_PAGES[i + 1]?.slug);
    });
  });

  it.each(DOC_PAGES.map((p) => [p.slug, p] as const))('%s: title, summary, Applies to, checked date and sections', (_slug, p) => {
    expect(p.title.trim()).not.toBe('');
    expect(p.summary.trim().length).toBeGreaterThan(20);
    expect(p.appliesTo.length).toBeGreaterThan(0);
    expect(new Set(p.appliesTo).size).toBe(p.appliesTo.length);
    for (const m of p.appliesTo) expect(DOC_MODES).toContain(m);
    expect(p.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const checked = new Date(`${p.checked}T00:00:00Z`);
    expect(Number.isNaN(checked.getTime())).toBe(false);
    expect(checked.toISOString().slice(0, 10)).toBe(p.checked);
    expect(checked.getTime()).toBeLessThanOrEqual(Date.now());
    expect(p.sections.length).toBeGreaterThan(0);
    for (const s of p.sections) {
      expect(s.title.trim()).not.toBe('');
      expect(s.blocks.length).toBeGreaterThan(0);
      for (const m of s.appliesTo ?? []) expect(p.appliesTo).toContain(m);
      for (const b of s.blocks) for (const m of b.appliesTo ?? []) expect(s.appliesTo ?? p.appliesTo).toContain(m);
    }
  });

  it.each(docPagesFor('LIVE').map((p) => [p.slug, p] as const))('%s: the LIVE view says nothing about the demo (ADR-116)', (_slug, p) => {
    expect(pageText(p)).not.toMatch(/\bdemo|simulat|seeded identit/i);
    for (const s of p.sections) {
      expect(s.blocks.length).toBeGreaterThan(0);
      expect(s.appliesTo ?? ['LIVE']).toContain('LIVE');
    }
    // Links stay inside the LIVE docs.
    for (const href of hrefsOf(nodesOf(p)).filter((h) => h.startsWith('/docs/') || h.startsWith('#'))) {
      const [pathname = '', fragment] = href.split('#');
      const target = pathname === '' ? p : getDocPage(pathname.split('/')[2] ?? '', 'LIVE');
      expect(target, href).toBeDefined();
      if (fragment !== undefined && target) expect(pageAnchors(target), href).toContain(fragment);
    }
  });

  it.each(DOC_PAGES.map((p) => [p.slug, p] as const))('%s: anchor ids are unique, kebab-case and not reserved', (_slug, p) => {
    const ids = pageAnchors(p);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(KEBAB);
      expect(RESERVED_IDS.has(id)).toBe(false);
    }
  });

  it.each(DOC_PAGES.map((p) => [p.slug, p] as const))('%s: tables are rectangular, code blocks have captions, lists are not empty', (_slug, p) => {
    for (const b of blocksOf(p)) {
      if (b.kind === 'table') {
        expect(b.caption.trim()).not.toBe('');
        expect(b.rows.length).toBeGreaterThan(0);
        for (const row of b.rows) expect(row.length).toBe(b.head.length);
      }
      if (b.kind === 'code') {
        expect(b.caption.trim()).not.toBe('');
        expect(b.code.trim()).not.toBe('');
      }
      if (b.kind === 'list' || b.kind === 'ordered') expect(b.items.length).toBeGreaterThan(0);
    }
  });

  it.each(DOC_PAGES.map((p) => [p.slug, p] as const))('%s: no placeholder words', (_slug, p) => {
    const text = pageText(p);
    for (const re of FORBIDDEN) expect(text).not.toMatch(re);
  });

  it('marks the local DEMO guide DEMO only and the deployment guide LIVE only', () => {
    expect(page('getting-started').appliesTo).toEqual(['DEMO']);
    expect(page('going-live').appliesTo).toEqual(['LIVE']);
  });
});

// ---- links and code ------------------------------------------------------------------------------

describe('docs content names only what exists', () => {
  it.each(DOC_PAGES.map((p) => [p.slug, p] as const))('%s: every link resolves', (_slug, p) => {
    const problems = hrefsOf(nodesOf(p))
      .map((href) => checkLink(p, href))
      .filter((x): x is string => x !== null);
    expect(problems).toEqual([]);
  });

  it.each(DOC_PAGES.map((p) => [p.slug, p] as const))('%s: every code span names a real script, env key, path, route, code or message', (_slug, p) => {
    const problems = codeSpansOf(nodesOf(p))
      .map((span) => checkCodeSpan(span, { phrases: true }))
      .filter((x): x is string => x !== null);
    expect(problems).toEqual([]);
  });

  it.each(DOC_PAGES.map((p) => [p.slug, p] as const))('%s: every command and env line in a code block is real', (_slug, p) => {
    const problems = blocksOf(p).flatMap((b) => (b.kind === 'code' ? checkCodeBlock(b) : []));
    expect(problems).toEqual([]);
  });

  it('the checker itself rejects what does not exist', () => {
    expect(checkCodeSpan('npm run no-such-script')).toMatch(/not in package\.json/);
    expect(checkCodeSpan('npm install left-pad')).toMatch(/only npm ci/);
    expect(checkCodeSpan('NO_SUCH_ENV_KEY=1')).toMatch(/not in \.env\.example/);
    expect(checkCodeSpan('NO_SUCH_REASON_CODE')).toMatch(/does not occur/);
    expect(checkCodeSpan('src/no/such/file.ts')).toMatch(/does not exist/);
    expect(checkCodeSpan('/dashboard/user/no-such-page')).toMatch(/not in the route manifest/);
    expect(checkCodeSpan('no.such.jobType')).toMatch(/does not occur/);
    expect(checkCodeSpan('Refusing to fly:', { phrases: true })).toMatch(/does not occur/);
    expect(checkCodeSpan('worker failed to start:', { phrases: true })).toBeNull();
    expect(checkCodeSpan('npm run db:backup')).toBeNull();
    expect(checkCodeSpan('SUPPRESSION_PEPPER')).toBeNull();
    expect(checkCodeSpan('/dashboard/employee/<ws>/leads')).toBeNull();
    expect(checkCodeSpan('pipeline.advance')).toBeNull();
    const p = page('security');
    expect(checkLink(p, 'javascript:alert(1)')).toMatch(/safeHref/);
    expect(checkLink(p, '/docs/no-such-page')).toMatch(/no docs page/);
    expect(checkLink(p, '#no-such-anchor')).toMatch(/missing/);
    expect(checkLink(p, 'http://example.com')).toMatch(/unsupported/);
  });
});

// ---- facts compared with the code ---------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('docs facts match the code', () => {
  it('messaging rules list every eligibility reason code, in check order, with the UI label and deferral', () => {
    const table = tableWithHead(page('messaging-rules'), 'Reason code');
    const codes = table.rows.map((r) => codeSpansOf(parseInline(r[0]!))[0]);
    expect(codes).toEqual([...REASON_ORDER]);
    table.rows.forEach((row, i) => {
      const code = REASON_ORDER[i]!;
      expect(inlineText(parseInline(row[1]!))).toBe(REASON_LABELS[code]);
      expect(row[2]).toBe(DEFERRABLE_REASONS.has(code) ? 'Waits' : 'Skipped');
    });
  });

  it('messaging rules list the exact Stop and Start keywords', () => {
    const table = tableWithHead(page('messaging-rules'), 'Intent');
    const keywords = (label: string) => {
      const row = table.rows.find((r) => r[0] === label);
      if (!row) throw new Error(`no keyword row ${label}`);
      return codeSpansOf(parseInline(row[1]!));
    };
    expect(keywords('Stop')).toEqual([...STOP_KEYWORDS]);
    expect(keywords('Start')).toEqual([...START_KEYWORDS]);
  });

  it('the security page lists the real rate limits', () => {
    const table = tableWithHead(page('security'), 'Limit');
    expect(table.rows.length).toBeGreaterThan(0);
    for (const row of table.rows) {
      const name = codeSpansOf(parseInline(row[0]!))[0] as RateLimitPolicyName | undefined;
      expect(name && name in RATE_LIMIT_POLICIES, `policy ${name}`).toBe(true);
      const policy = RATE_LIMIT_POLICIES[name!];
      expect(row[1]).toBe(String(policy.limit));
      expect(row[2]).toBe(policy.windowMs === MINUTE ? '1 minute' : policy.windowMs === HOUR ? '1 hour' : `${policy.windowMs} ms`);
    }
  });

  const FACTS: ReadonlyArray<readonly [string, string]> = [
    ['security', `argon2id (memory ${ARGON2_PARAMS.memoryCost} KiB, ${ARGON2_PARAMS.timeCost} passes, parallelism ${ARGON2_PARAMS.parallelism})`],
    ['security', `${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`],
    ['security', `${LOGIN_LOCKOUT.threshold} failed sign-ins in a row lock the account for ${LOGIN_LOCKOUT.durationMs / MINUTE} minutes`],
    ['security', `idle timeout of ${SESSION_POLICY.idleMs / DAY} days`],
    ['security', `absolute limit of ${SESSION_POLICY.absoluteMs / DAY} days`],
    ['security', `super admin sessions end after ${SESSION_POLICY.superAdminAbsoluteMs / HOUR} hours`],
    ['security', `within the last ${SESSION_POLICY.reauthWindowMs / MINUTE} minutes`],
    ['security', `Invite links expire after ${INVITE_TTL_MS / HOUR} hours`],
    ['security', `Reset links expire after ${PASSWORD_RESET_TTL_MS / HOUR} hour`],
    ['troubleshooting', `older than ${WORKER_STALE_AFTER_MS / 1000} seconds`],
    ['troubleshooting', `${LOGIN_LOCKOUT.threshold} failed sign-ins in a row`],
    ['troubleshooting', `${LOGIN_LOCKOUT.durationMs / MINUTE} minutes`],
    ['data-and-privacy', `${PROCESSED_RETENTION_MS / DAY} days after it was processed`],
    ['data-and-privacy', `${UNRESOLVED_RETENTION_MS / DAY} days after it was received`],
    ['data-and-privacy', 'not legal advice'],
  ];

  it.each(FACTS)('%s states "%s"', (slug, fact) => {
    expect(pageText(page(slug))).toContain(fact);
  });
});

// ---- lead-gen suite facts (ADR-117 to ADR-135) --------------------------------------------------

const MB = 1024 * 1024;
const num = (n: number) => n.toLocaleString('en-US');
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

describe('lead-gen docs facts match the code', () => {
  const [perQueryA, perQueryB, perQueryC] = FINDER_LIMITS.perQueryOptions;

  const FACTS: ReadonlyArray<readonly [string, string]> = [
    // Lead Finder
    ['lead-finder', `At most ${FINDER_LIMITS.maxKeywords} of each, so at most ${FINDER_LIMITS.maxKeywords * FINDER_LIMITS.maxLocations} searches`],
    ['lead-finder', `A keyword is at most ${FINDER_LIMITS.maxKeywordLength} characters, a location at most ${FINDER_LIMITS.maxLocationLength}`],
    ['lead-finder', `Up to ${perQueryA}, ${perQueryB} or ${perQueryC}, your choice`],
    ['lead-finder', `${RATE_LIMIT_POLICIES.finderRun.limit} per workspace (the finderRun limit`],
    ['lead-finder', `${FINDER_LIMITS.maxImport} (the grid shows ${FINDER_LIMITS.pageSize} results per page)`],
    ['lead-finder', `${FINDER_LIMITS.maxRefresh}, because each refresh is a paid Google request`],
    ['lead-finder', `it is kept for ${FINDER_CONTENT_TTL_MS / 3_600_000} hours after it was fetched`],
    ['lead-finder', `carry an expiry of ${PLACES_CONTENT_TTL_DAYS} days after the import`],
    ['lead-finder', `up to ${num(FINDER_EXPORT_ROW_CAP)} rows`],
    ['lead-finder', `gives each page at most ${EMAIL_PAGE_LIMITS.totalTimeoutMs / 1000} seconds and ${EMAIL_PAGE_LIMITS.maxBytes / MB} MB`],
    ['lead-finder', `At most ${MAX_EMAILS_PER_RESULT} are kept per business`],
    // File import and export
    ['import-and-export', `At most ${num(LEAD_IMPORT_MAX_ROWS)} data rows below the header, and ${SPREADSHEET_LIMITS.maxColumns} columns`],
    ['import-and-export', `of at most ${SPREADSHEET_LIMITS.maxFileBytes / MB} MB`],
    ['import-and-export', `the first ${LEAD_IMPORT_PREVIEW_ROWS} rows`],
    ['import-and-export', `${LEAD_IMPORT_CHUNK} rows at a time`],
    ['import-and-export', `${LEAD_IMPORT_TTL_HOURS} hours after the upload`],
    ['import-and-export', `${RATE_LIMIT_POLICIES.leadImport.limit} uploads or confirmations a minute`],
    ['import-and-export', `A business name up to ${IMPORT_FIELD_MAX_LENGTH.name} characters, an email up to ${IMPORT_FIELD_MAX_LENGTH.email}, a website up to ${num(IMPORT_FIELD_MAX_LENGTH.website)}, an address up to ${num(IMPORT_FIELD_MAX_LENGTH.address)}`],
    ['import-and-export', `a file holds at most ${num(LEAD_EXPORT_ROW_CAP)} leads`],
    ['import-and-export', `stays ready for ${LEAD_EXPORT_TTL_HOURS} hours`],
    ['import-and-export', IMPORT_DATA_SOURCE_LABELS.OWN_CUSTOMERS],
    ['import-and-export', IMPORT_DATA_SOURCE_LABELS.OWN_FORM_OR_EVENT],
    ['import-and-export', consentAttestationText('<business>')],
    [
      'import-and-export',
      `${IMPORT_CONSENT_TRUTHY_VALUES.slice(0, -1).join(', ')} or ${IMPORT_CONSENT_TRUTHY_VALUES.at(-1)}`,
    ],
    ['security', `a workbook may not inflate beyond ${SPREADSHEET_LIMITS.maxUncompressedBytes / MB} MB`],
    ['security', `at most ${MEDIA_PDF_MAX_BYTES / MB} MB`],
    // Inbox and automatic replies
    ['inbox-and-ai-replies', `After ${AUTOMATED_REPLY_CAP} automatic replies in a row`],
    ['inbox-and-ai-replies', `the last ${CONVERSATION_HISTORY_LIMIT} messages of the thread`],
    ['inbox-and-ai-replies', automatedReplyDisclosure('<Business>')],
    // Template studio
    ['template-studio', `up to ${TEMPLATE_LIMITS.name} characters`],
    ['template-studio', `text of at most ${TEMPLATE_LIMITS.headerText} characters with at most one variable`],
    ['template-studio', `at most ${num(TEMPLATE_LIMITS.body)} characters. Variables are numbered`],
    ['template-studio', `at most ${TEMPLATE_LIMITS.variables}, and never at the very start or end`],
    ['template-studio', `Optional, at most ${TEMPLATE_LIMITS.footer} characters, no variables`],
    [
      'template-studio',
      `At most ${TEMPLATE_LIMITS.quickReplies} quick replies, ${TEMPLATE_LIMITS.urlButtons} website links (a fixed https address) and ${TEMPLATE_LIMITS.phoneButtons} call button, each with a text of at most ${TEMPLATE_LIMITS.buttonText} characters`,
    ],
    ['template-studio', `promotional words (${PROMOTIONAL_WORDS.join(', ')})`],
    ['template-studio', `at most ${MEDIA_PDF_MAX_BYTES / MB} MB`],
    ['template-studio', `A workspace may submit ${RATE_LIMIT_POLICIES.templateSubmit.limit} templates an hour`],
    ['template-studio', `${DEMO_TEMPLATE_REVIEW_DELAY_MS / 1000} seconds later a simulated review`],
    ['getting-started', `About ${DEMO_TEMPLATE_REVIEW_DELAY_MS / 1000} seconds later the simulated review`],
    // Hand over
    ['reach-out-and-handoff', `The limit is ${RATE_LIMIT_POLICIES.handoff.limit} handovers a minute per person`],
    // Retention
    ['data-and-privacy', `Removed ${FINDER_CONTENT_TTL_MS / 3_600_000} hours after it was fetched`],
    ['data-and-privacy', `Removed ${PLACES_CONTENT_TTL_DAYS} days after the import`],
    ['data-and-privacy', `or ${LEAD_IMPORT_TTL_HOURS} hours after the upload`],
    ['data-and-privacy', `Ready for ${LEAD_EXPORT_TTL_HOURS} hours, then deleted`],
    // Limits
    ['limitations', `At most ${FINDER_LIMITS.maxKeywords} keywords and ${FINDER_LIMITS.maxLocations} locations`],
    ['limitations', `At most ${num(LEAD_IMPORT_MAX_ROWS)} rows and ${SPREADSHEET_LIMITS.maxFileBytes / MB} MB per file`],
  ];

  it.each(FACTS)('%s states "%s"', (slug, fact) => {
    expect(pageText(page(slug))).toContain(fact);
  });

  it('keeps the export cap and the active-export cap in step with the import page', () => {
    expect(LEAD_EXPORT_ACTIVE_CAP).toBe(3);
    expect(pageText(page('import-and-export'))).toContain('at most three exports that are preparing or ready');
  });

  it('the fixed hand-over reply the inbox page quotes is the one the guard sends', () => {
    const quoted = 'a member of our team will reply to you here';
    expect(FIXED_REPLIES.handoff.toLowerCase()).toContain(quoted);
    expect(pageText(page('inbox-and-ai-replies'))).toContain(quoted);
  });

  it('the template page names both studio categories and every utility trigger', () => {
    const text = pageText(page('template-studio'));
    for (const category of STUDIO_CATEGORIES) expect(text).toContain(category);
    for (const label of Object.values(UTILITY_TRIGGER_LABELS)) expect(text.toLowerCase()).toContain(lowerFirst(label).replace(/^the /, ''));
  });

  it('the reach-out page lists every opt-in method with its code and wording', () => {
    const text = pageText(page('reach-out-and-handoff'));
    for (const method of OPT_IN_METHODS) {
      expect(text).toContain(method);
      expect(text).toContain(lowerFirst(OPT_IN_METHOD_LABELS[method]));
    }
  });

  it('the capability table lists the lead-gen capabilities and marks members as the code does', () => {
    const p = page('roles-and-panels');
    expect(pageText(p)).toContain(`There are ${CAPABILITIES.length} capabilities`);
    const table = tableWithHead(p, 'Capability');
    const listed = table.rows.map((r) => codeSpansOf(parseInline(r[0]!))[0] as Capability);
    for (const capability of ['finder.run', 'leads.import', 'consent.import', 'templates.manage', 'leads.handoff'] as const) expect(listed).toContain(capability);
    table.rows.forEach((row, i) => {
      expect(CAPABILITIES as readonly string[], listed[i]).toContain(listed[i]);
      expect(row[2], listed[i]).toBe(MEMBER_CAPABILITIES.has(listed[i]!) ? 'Yes' : 'No');
    });
  });

  it('the DEMO guide names every seeded identity and business', () => {
    const text = pageText(page('getting-started'));
    expect(text).toContain(`lists ${['zero', 'one', 'two', 'three', 'four', 'five', 'six'][DEMO_PERSONA_KEYS.length]} seeded identities`);
    for (const key of DEMO_PERSONA_KEYS) expect(text).toContain(DEMO_PERSONAS[key].label);
    expect(text).toContain(`The seed holds ${['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'][WORKSPACE_FIXTURES.length]} invented businesses`);
    for (const workspace of WORKSPACE_FIXTURES) expect(text).toContain(workspace.name);
  });
});

// ---- repo docs -------------------------------------------------------------------------------------

const REPO_DOCS = ['README.md', 'docs/architecture.md', 'docs/deployment.md', 'docs/runbooks.md'];

describe('repo docs name only what exists', () => {
  it.each(REPO_DOCS)('%s exists', (file) => {
    expect(existsSync(path.join(ROOT, file))).toBe(true);
  });

  it.each(REPO_DOCS)('%s: code spans, commands and relative links are real', (file) => {
    const text = read(file);
    const problems: string[] = [];
    // Fenced blocks: every command line.
    for (const fence of text.matchAll(/```(\w*)\n([\s\S]*?)```/g)) {
      const language = fence[1] === 'env' ? 'env' : 'bash';
      problems.push(...checkCodeBlock({ kind: 'code', language, caption: file, code: fence[2]! }));
    }
    const prose = text.replace(/```[\s\S]*?```/g, '');
    for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
      const problem = checkCodeSpan(m[1]!);
      if (problem) problems.push(problem);
    }
    for (const m of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = m[1]!;
      if (/^https:\/\//.test(href)) continue;
      if (href.startsWith('/')) {
        if (!routeExists(href)) problems.push(`route ${href} is not in the route manifest`);
        continue;
      }
      const target = path.normalize(path.join(path.dirname(file), href.split('#')[0]!));
      if (!existsSync(path.join(ROOT, target))) problems.push(`link ${href} does not resolve`);
    }
    for (const re of FORBIDDEN) if (re.test(prose)) problems.push(`placeholder ${re}`);
    expect(problems).toEqual([]);
  });
});
