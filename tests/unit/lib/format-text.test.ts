import { describe, expect, it } from 'vitest';
import { truncateAtWord } from '@/lib/format/text';

describe('truncateAtWord', () => {
  it('returns short text unchanged (trimmed, whitespace collapsed)', () => {
    expect(truncateAtWord('  Hello   there\nfriend ', 140)).toBe('Hello there friend');
  });

  it('cuts at the last word boundary and adds an ellipsis', () => {
    const text = 'Thanks for the details, we have prepared a quotation covering the scope and timeline you asked for.';
    const out = truncateAtWord(text, 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('…')).toBe(true);
    expect(text.startsWith(out.slice(0, -1))).toBe(true);
    expect(out).not.toMatch(/\s…$/);
    // The character after the kept head in the original is a space, so no word was split.
    expect(text[out.length - 1]).toMatch(/[\s,]/);
  });

  it('drops trailing punctuation before the ellipsis', () => {
    expect(truncateAtWord('One, two, three, four, five, six', 18)).toBe('One, two, three…');
  });

  it('cuts a single very long word mid-word rather than returning only the ellipsis', () => {
    const out = truncateAtWord('x'.repeat(50), 10);
    expect(out).toBe(`${'x'.repeat(9)}…`);
  });

  it('never exceeds max', () => {
    for (const max of [1, 2, 5, 17, 140, 160]) {
      expect(truncateAtWord('lorem ipsum dolor sit amet '.repeat(20), max).length).toBeLessThanOrEqual(max);
    }
  });
});
