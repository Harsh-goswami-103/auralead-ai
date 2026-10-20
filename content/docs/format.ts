/**
 * The in-app documentation format (T37, ADR-90). Pages are typed TypeScript data, not Markdown:
 * there is no Markdown library, no HTML in the content and nothing is ever rendered with
 * dangerouslySetInnerHTML. A page is a list of sections with stable ids (the "On this page"
 * anchors), and a section is a list of blocks. Strings inside blocks may use three inline marks,
 * parsed by `parseInline` below:
 *   `code`            literal text in a code span (commands, env keys, paths, codes)
 *   **bold**          emphasis (may contain code spans)
 *   [label](href)     a link; the renderer sends every href through safeHref (no javascript:)
 * There is no escaping: a backtick, `**` or `[` that does not open a complete mark is plain text.
 *
 * tests/unit/docs/content.test.ts keeps the content honest: ids are unique, every internal link
 * and anchor resolves, and every npm script, env key, repo path, route and code named in a code
 * span exists in this repository. Framework-free: imported by the docs pages and by the tests.
 */

export const DOC_MODES = ['DEMO', 'LIVE'] as const;
export type DocMode = (typeof DOC_MODES)[number];

export type CodeLanguage = 'bash' | 'powershell' | 'env' | 'text';
export type CalloutTone = 'note' | 'warning' | 'limit';

export type DocBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: readonly string[] }
  | { kind: 'ordered'; items: readonly string[] }
  | { kind: 'code'; language: CodeLanguage; caption: string; code: string }
  | { kind: 'callout'; tone: CalloutTone; text: string }
  | { kind: 'table'; caption: string; head: readonly string[]; rows: readonly (readonly string[])[] }
  | { kind: 'subheading'; id: string; text: string };

export type DocSection = {
  /** Stable anchor id (kebab-case), unique within the page. */
  id: string;
  title: string;
  /** Only when the section applies to fewer modes than its page. */
  appliesTo?: readonly DocMode[];
  blocks: readonly DocBlock[];
};

export type DocPage = {
  /** URL segment under /docs (kebab-case), unique across pages. */
  slug: string;
  title: string;
  /** One or two sentences: the page's description and its card text on /docs. */
  summary: string;
  appliesTo: readonly DocMode[];
  /** ISO date (YYYY-MM-DD) the page was last checked against the code. */
  checked: string;
  sections: readonly DocSection[];
};

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'link'; href: string; children: InlineNode[] };

/** Index of the backtick closing a code span opened at `open`, or -1. Empty spans do not count. */
function codeEnd(source: string, open: number): number {
  const end = source.indexOf('`', open + 1);
  return end > open + 1 ? end : -1;
}

/** Index of `token` at or after `from`, skipping code spans; -1 when absent. */
function findOutsideCode(source: string, token: string, from: number): number {
  let i = from;
  while (i < source.length) {
    if (source[i] === '`') {
      const end = codeEnd(source, i);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }
    if (source.startsWith(token, i)) return i;
    i++;
  }
  return -1;
}

/** Index of the `)` that closes a link target starting at `from`, allowing balanced parentheses inside; -1 when absent. */
function hrefClose(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/**
 * Parses the inline marks of one content string. Links do not nest and bold does not nest; a code
 * span is literal (nothing inside it is parsed).
 */
export function parseInline(source: string, options: { links?: boolean; strong?: boolean } = {}): InlineNode[] {
  const links = options.links ?? true;
  const strong = options.strong ?? true;
  const out: InlineNode[] = [];
  let text = '';
  const flush = () => {
    if (text !== '') out.push({ type: 'text', value: text });
    text = '';
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '`') {
      const end = codeEnd(source, i);
      if (end !== -1) {
        flush();
        out.push({ type: 'code', value: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    } else if (strong && source.startsWith('**', i)) {
      const end = findOutsideCode(source, '**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ type: 'strong', children: parseInline(source.slice(i + 2, end), { links, strong: false }) });
        i = end + 2;
        continue;
      }
    } else if (links && ch === '[') {
      const close = findOutsideCode(source, '](', i + 1);
      const hrefEnd = close === -1 ? -1 : hrefClose(source, close + 2);
      const href = hrefEnd === -1 ? '' : source.slice(close + 2, hrefEnd);
      if (close > i + 1 && href !== '' && !/\s/.test(href)) {
        flush();
        out.push({ type: 'link', href, children: parseInline(source.slice(i + 1, close), { links: false, strong }) });
        i = hrefEnd + 1;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

/** The plain text a reader sees (marks removed). */
export function inlineText(nodes: readonly InlineNode[]): string {
  return nodes.map((n) => (n.type === 'text' || n.type === 'code' ? n.value : inlineText(n.children))).join('');
}

/** Every inline string of a page (summary, headings, block texts, list items, table cells, callouts). */
export function inlineStrings(page: DocPage): string[] {
  const out: string[] = [page.title, page.summary];
  for (const section of page.sections) {
    out.push(section.title);
    for (const block of section.blocks) {
      switch (block.kind) {
        case 'paragraph':
        case 'callout':
          out.push(block.text);
          break;
        case 'list':
        case 'ordered':
          out.push(...block.items);
          break;
        case 'table':
          out.push(block.caption, ...block.head, ...block.rows.flat());
          break;
        case 'subheading':
          out.push(block.text);
          break;
        case 'code':
          out.push(block.caption);
          break;
      }
    }
  }
  return out;
}

/** Anchor ids a page defines: its sections and its subheadings, in page order. */
export function pageAnchors(page: DocPage): string[] {
  const ids: string[] = [];
  for (const section of page.sections) {
    ids.push(section.id);
    for (const block of section.blocks) if (block.kind === 'subheading') ids.push(block.id);
  }
  return ids;
}

/** `2026-10-20` -> `20 Oct 2026` (date-only, no time zone involved). */
export function formatCheckedDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1] ?? ''} ${m[1]}`;
}
