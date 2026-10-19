/**
 * Short previews of free text (thread lists, approval queues). A hard `slice` cut words in half
 * ("covering the scope and t"), which reads as broken data; this cuts at the last word boundary
 * that fits and marks the cut with an ellipsis. Whitespace runs collapse to one space first, so a
 * multi-line message previews as one line.
 */
const ELLIPSIS = '…';

export function truncateAtWord(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  if (max <= ELLIPSIS.length) return flat.slice(0, max);
  const room = max - ELLIPSIS.length;
  const cut = flat.slice(0, room);
  const boundary = cut.lastIndexOf(' ');
  // A single very long word has no boundary worth keeping: cut it mid-word rather than show nothing.
  const head = boundary >= room * 0.6 ? cut.slice(0, boundary) : cut;
  return `${head.replace(/[\s.,;:!?-]+$/, '')}${ELLIPSIS}`;
}
