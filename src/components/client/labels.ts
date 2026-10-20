/**
 * Client-panel wording helpers (design spec §6; user report bugs "1 days", raw generator ids and raw
 * audit codes). Pure functions with no hooks or Next imports, so server and client components share
 * them: a count with the right noun, the human name of a draft generator, and the label of a quote
 * audit action with a humanised fallback so a dotted code never reaches the screen.
 */

/** `plural(1, 'day', 'days')` is "1 day"; `plural(3, 'day', 'days')` is "3 days". */
export function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-IN')} ${count === 1 ? one : many}`;
}

/** "1 day", "15 days". */
export const days = (count: number) => plural(count, 'day', 'days');

/** Draft generators as people should read them (the same names the lead console shows). */
export const GENERATOR_LABELS: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'local-deterministic': 'Local template (deterministic)',
  none: 'Not generated',
};

export function generatorLabel(id: string): string {
  return GENERATOR_LABELS[id] ?? humanize(id);
}

/** "quote.share.create" -> "Share create"; "SOME_CODE" -> "Some code". Last resort only. */
export function humanize(code: string): string {
  const words = code
    .replace(/^quote\./, '')
    .split(/[._\-\s]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return 'Updated';
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
