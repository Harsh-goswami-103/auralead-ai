/**
 * Website email extraction rules (ADR-118, slice F1, P1). Pure: HTML and robots.txt text in,
 * decisions out; the crawl that fetches them is `emails.ts`.
 *
 * - Candidates come from `mailto:` links and from addresses written in the page text (entity- and
 *   percent-encoded `@` included). File names that look like addresses (`logo@2x.png`) are not.
 * - Dropped: placeholders (example.com, yourdomain, `your@`, `name@`, `email@`, ...), the run's
 *   blacklist (a whole address, or a domain and its subdomains) and anything not a plausible
 *   address. Kept addresses are lower-cased and de-duplicated.
 * - Kind: FREEMAIL for public mailbox providers, ROLE for role mailboxes (info, contact, sales, ...),
 *   else PERSONAL.
 * - Contact pages: at most two same-host links whose path or text names a contact page.
 * - robots.txt: the group for our bot's token, else `*`; the longest matching Allow or Disallow
 *   wins; an empty Disallow allows everything.
 */
export type ExtractedEmail = { address: string; sourceUrl: string; kind: 'ROLE' | 'PERSONAL' | 'FREEMAIL' };

export const ROBOTS_AGENT_TOKEN = 'auraleadbot';
/** Kept per result (a contact page rarely lists more). */
export const MAX_EMAILS_PER_RESULT = 10;

const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'ymail.com', 'rocketmail.com', 'hotmail.com', 'hotmail.co.in', 'outlook.com', 'outlook.in', 'live.com', 'live.in', 'msn.com',
  'rediffmail.com', 'rediff.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'protonmail.com', 'proton.me', 'zoho.in', 'zohomail.in', 'mail.com', 'gmx.com', 'yandex.com', 'inbox.com',
]);
const ROLE_LOCALS = new Set([
  'info', 'contact', 'contactus', 'hello', 'hi', 'sales', 'support', 'enquiry', 'enquiries', 'inquiry', 'inquiries', 'admin', 'office', 'booking', 'bookings', 'reservations', 'reservation',
  'care', 'customercare', 'help', 'team', 'mail', 'marketing', 'hr', 'careers', 'jobs', 'accounts', 'billing', 'orders', 'order', 'service', 'services', 'reception', 'appointments',
  'appointment', 'feedback', 'business', 'connect', 'enquire', 'query', 'queries',
]);
const PLACEHOLDER_DOMAINS = /(^|\.)(example\.(com|org|net|in)|domain\.(com|in)|yourdomain\.[a-z.]+|yourcompany\.[a-z.]+|yoursite\.[a-z.]+|website\.com|email\.com|test\.com|sentry\.io|wixpress\.com|sentry-next\.wixpress\.com)$/;
const PLACEHOLDER_LOCALS = new Set(['your', 'youremail', 'your.email', 'yourname', 'name', 'email', 'user', 'username', 'someone', 'you', 'john.doe', 'johndoe', 'jane.doe', 'firstname.lastname', 'test', 'abc', 'xyz', 'noreply', 'no-reply', 'donotreply']);
const FILE_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'css', 'js', 'ico', 'bmp', 'tif', 'tiff', 'avif', 'pdf', 'mp4', 'woff', 'woff2']);
const ADDRESS_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;
const VALID_RE = /^[a-z0-9._%+-]{1,64}@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24})$/;

function decodeEntities(html: string): string {
  return html
    .replace(/&#0*64;|&#x0*40;|&commat;/gi, '@')
    .replace(/&#0*46;|&#x0*2e;|&period;/gi, '.')
    .replace(/&amp;/gi, '&');
}

/** Lower-cased addresses written on the page: `mailto:` links first, then the text. */
export function emailCandidates(html: string): string[] {
  const text = decodeEntities(html);
  const out: string[] = [];
  const push = (raw: string) => {
    const a = raw.trim().toLowerCase();
    if (!out.includes(a)) out.push(a);
  };
  for (const m of text.matchAll(/mailto:([^"'?\s>]+)/gi)) {
    let value = m[1]!;
    try {
      value = decodeURIComponent(value);
    } catch {
      continue;
    }
    for (const part of value.split(',')) push(part);
  }
  for (const m of text.matchAll(ADDRESS_RE)) push(m[0]);
  return out;
}

export function isPlausibleAddress(address: string): boolean {
  if (address.length > 254) return false;
  const m = VALID_RE.exec(address);
  if (!m) return false;
  const domain = m[1]!;
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  if (FILE_TLDS.has(tld)) return false;
  const local = address.slice(0, address.indexOf('@'));
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  return true;
}

export function isPlaceholder(address: string): boolean {
  const at = address.indexOf('@');
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  return PLACEHOLDER_LOCALS.has(local) || PLACEHOLDER_DOMAINS.test(domain);
}

/** True when the run's blacklist names this address or its domain (or a parent domain). */
export function blacklisted(address: string, blacklist: readonly string[]): boolean {
  const domain = address.slice(address.indexOf('@') + 1);
  return blacklist.some((entry) => {
    const e = entry.trim().toLowerCase().replace(/^@/, '');
    if (e === '') return false;
    if (e.includes('@')) return e === address;
    return domain === e || domain.endsWith(`.${e}`);
  });
}

export function emailKind(address: string): ExtractedEmail['kind'] {
  const at = address.indexOf('@');
  const domain = address.slice(at + 1);
  if (FREEMAIL_DOMAINS.has(domain)) return 'FREEMAIL';
  const local = address.slice(0, at).replace(/[._+-]?\d+$/, '');
  return ROLE_LOCALS.has(local) ? 'ROLE' : 'PERSONAL';
}

/** The addresses of one page that may be kept, with their kind and the page they were found on. */
export function keepEmails(candidates: readonly string[], sourceUrl: string, blacklist: readonly string[]): ExtractedEmail[] {
  return candidates.filter((a) => isPlausibleAddress(a) && !isPlaceholder(a) && !blacklisted(a, blacklist)).map((address) => ({ address, sourceUrl, kind: emailKind(address) }));
}

export function mergeEmails(lists: ReadonlyArray<readonly ExtractedEmail[]>): ExtractedEmail[] {
  const out: ExtractedEmail[] = [];
  for (const list of lists) for (const e of list) if (!out.some((o) => o.address === e.address)) out.push(e);
  return out.slice(0, MAX_EMAILS_PER_RESULT);
}

const CONTACT_RE = /contact|reach-?us|get-?in-?touch|enquir|inquir|about|support|connect/i;
/** An anchor's tag and label are read from this many characters after its `<a`. */
const ANCHOR_WINDOW = 2_048;
const MAX_HREF_LENGTH = 2_048;
const ANCHOR_HREF_RE = /\bhref\s*=\s*["']([^"'#]+)["']/i;

/** Up to two same-host pages the home page links to that look like contact pages. */
export function contactPageUrls(html: string, pageUrl: string, limit = 2): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const out: string[] = [];
  // Linear scan: every `<a` looks only at a bounded window after it, so a page of unclosed tags
  // (hostile or just broken) cannot make the work grow with the square of its size.
  const anchorStart = /<a\s/gi;
  while (out.length < limit) {
    const found = anchorStart.exec(html);
    if (found === null) break;
    const start = found.index;
    const window = html.slice(start, start + ANCHOR_WINDOW);
    const close = window.indexOf('>');
    if (close === -1) continue;
    const href = ANCHOR_HREF_RE.exec(window.slice(0, close))?.[1]?.trim();
    if (!href || href.length > MAX_HREF_LENGTH) continue;
    const rest = window.slice(close + 1);
    const end = rest.toLowerCase().indexOf('</a>');
    const label = (end === -1 ? rest : rest.slice(0, end)).replace(/<[^>]*>/g, ' ');
    if (!CONTACT_RE.test(href) && !CONTACT_RE.test(label)) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname !== base.hostname) continue;
    url.hash = '';
    const s = url.toString();
    if (s === base.toString() || out.includes(s)) continue;
    out.push(s);
  }
  return out;
}

type Rule = { allow: boolean; path: string };

/** A rule longer than this, a path longer than this, or more rules than this are not matched or kept. */
const MAX_RULE_LENGTH = 1_024;
const MAX_MATCH_PATH_LENGTH = 2_048;
const MAX_RULES = 2_000;

/** The robots.txt rules that apply to our bot (its own group, else `*`). */
export function robotsRules(text: string, token = ROBOTS_AGENT_TOKEN): Rule[] {
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'disallow') current.rules.push({ allow: false, path: value });
    else if (field === 'allow') current.rules.push({ allow: true, path: value });
  }
  const own = groups.filter((g) => g.agents.some((a) => a.split('/')[0]!.trim() === token));
  const chosen = own.length > 0 ? own : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules).slice(0, MAX_RULES);
}

/**
 * RFC 9309 pattern match without a RegExp: the pattern's `*` wildcards and optional trailing `$`
 * are matched left to right (each literal piece at its first position after the previous one), so
 * the work is bounded by pattern times path and a hostile robots.txt cannot cause backtracking.
 */
function ruleMatches(rawPath: string, pattern: string): boolean {
  if (pattern === '' || pattern.length > MAX_RULE_LENGTH) return false;
  const path = rawPath.length > MAX_MATCH_PATH_LENGTH ? rawPath.slice(0, MAX_MATCH_PATH_LENGTH) : rawPath;
  const anchored = pattern.endsWith('$');
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  const first = parts[0]!;
  if (parts.length === 1) return anchored ? path === first : path.startsWith(first);
  if (!path.startsWith(first)) return false;
  let pos = first.length;
  for (let i = 1; i < parts.length - 1; i += 1) {
    const found = path.indexOf(parts[i]!, pos);
    if (found === -1) return false;
    pos = found + parts[i]!.length;
  }
  const tail = parts[parts.length - 1]!;
  if (!anchored) return path.indexOf(tail, pos) !== -1;
  return path.length - tail.length >= pos && path.endsWith(tail);
}

/** Whether our bot may fetch `path` (path plus query) under these rules. */
export function robotsAllows(rules: readonly Rule[], path: string): boolean {
  let best: Rule | null = null;
  for (const r of rules) {
    if (!ruleMatches(path, r.path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best === null || best.allow;
}
