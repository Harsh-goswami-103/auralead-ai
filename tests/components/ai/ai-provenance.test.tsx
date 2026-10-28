/**
 * Lead-gen B2 (ADR-18, ADR-66 truthful UI): AiProvenance says who wrote AI-task output. Violet (the
 * --ai token, legal only in src/components/ai/**) appears only when a real model provider wrote it
 * (generatorInfo kind 'ai': anthropic, openai). The local generator reads "Local template", the
 * reply guard "Automatic reply", system texts "System text", unknown labels keep their own text and
 * are never violet, and a person's own text or no generator renders nothing.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AiProvenance } from '@/components/ai/AiProvenance';

afterEach(cleanup);

const VIOLET = /(?:^|\s)(?:text|bg|border)-ai(?:\/\d+)?(?:\s|$)/;
const violetIn = (root: HTMLElement) => [root, ...root.querySelectorAll<HTMLElement>('*')].some((el) => VIOLET.test(el.getAttribute('class') ?? ''));

describe('AiProvenance', () => {
  it.each(['anthropic', 'openai'])('%s output is a violet "AI prepared" chip with a sparkle icon', (label) => {
    const { container } = render(<AiProvenance generatorLabel={label} />);
    const chip = container.querySelector('[data-generator="ai"]') as HTMLElement;
    expect(chip.textContent).toBe('AI prepared');
    expect(chip.className).toMatch(/(?:^|\s)text-ai(?:\s|$)/);
    expect(chip.className).toMatch(/(?:^|\s)border-ai\/\d+(?:\s|$)/);
    expect(chip.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('names the provider, and the model when given, in the title', () => {
    const { container, rerender } = render(<AiProvenance generatorLabel="anthropic" />);
    expect(container.querySelector('[data-generator="ai"]')?.getAttribute('title')).toBe('Anthropic');
    rerender(<AiProvenance generatorLabel="openai" modelId="gpt-5.2" />);
    expect(container.querySelector('[data-generator="ai"]')?.getAttribute('title')).toBe('OpenAI, gpt-5.2');
  });

  it.each([
    ['local-deterministic', 'template', 'Local template'],
    ['reply-guard', 'automatic', 'Automatic reply'],
    ['system', 'system', 'System text'],
    ['some-new-model', 'other', 'some-new-model'],
  ])('%s is a neutral chip reading what it is, never violet', (label, kind, text) => {
    const { container } = render(<AiProvenance generatorLabel={label} />);
    const chip = container.querySelector(`[data-generator="${kind}"]`) as HTMLElement;
    expect(chip.textContent).toBe(text);
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(violetIn(container)).toBe(false);
    expect(container.textContent).not.toMatch(/\bAI\b/);
  });

  it.each([['human'], ['none'], [null], [undefined], ['']])('renders nothing for %s', (label) => {
    const { container } = render(<AiProvenance generatorLabel={label} />);
    expect(container.textContent).toBe('');
    expect(container.querySelector('[data-generator]')).toBeNull();
  });

  it('keeps a caller class', () => {
    const { container, rerender } = render(<AiProvenance generatorLabel="anthropic" className="mt-2" />);
    expect(container.querySelector('[data-generator="ai"]')?.className).toContain('mt-2');
    rerender(<AiProvenance generatorLabel="local-deterministic" className="mt-2" />);
    expect(container.querySelector('[data-generator="template"]')?.className).toContain('mt-2');
  });
});
