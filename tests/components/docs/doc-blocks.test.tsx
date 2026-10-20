/**
 * T37: the docs renderer (src/app/(public)/docs/_components). Inline marks become real elements
 * (code, strong, links) and never raw HTML; every href goes through safeHref, so a `javascript:`
 * or `data:` link renders as plain text; internal links stay same-origin and external ones carry
 * rel="noreferrer". Blocks: lists keep their order, subheadings carry their anchor id, callouts
 * show an icon and a text label (never color alone), tables and code blocks scroll inside a
 * focusable labelled region, and the code block's Copy button really writes the code to the
 * clipboard and says so.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { DocBlocks } from '@/app/(public)/docs/_components/DocBlocks';
import { Inline } from '@/app/(public)/docs/_components/Inline';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Inline', () => {
  it('renders code spans, bold and plain text without parsing inside code', () => {
    const { container } = render(<p>{<Inline text="Run `npm run setup` and **back up `SUPPRESSION_PEPPER`**, then `a **b** c`." />}</p>);
    const codes = [...container.querySelectorAll('code')].map((c) => c.textContent);
    expect(codes).toEqual(['npm run setup', 'SUPPRESSION_PEPPER', 'a **b** c']);
    const strong = container.querySelector('strong');
    expect(strong?.textContent).toBe('back up SUPPRESSION_PEPPER');
    expect(container.textContent).toBe('Run npm run setup and back up SUPPRESSION_PEPPER, then a **b** c.');
    expect(container.innerHTML).not.toContain('**back');
  });

  it('renders internal, fragment and external links', () => {
    render(<p>{<Inline text="See [Security](/docs/security#csrf), [below](#limits) and [the spec](https://example.com/spec)." />}</p>);
    const internal = screen.getByRole('link', { name: 'Security' });
    expect(internal.getAttribute('href')).toBe('/docs/security#csrf');
    expect(screen.getByRole('link', { name: 'below' }).getAttribute('href')).toBe('#limits');
    const external = screen.getByRole('link', { name: 'the spec' });
    expect(external.getAttribute('href')).toBe('https://example.com/spec');
    expect(external.getAttribute('rel')).toBe('noreferrer');
  });

  it.each(['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example'])('renders %s as plain text, never a link', (href) => {
    const { container } = render(<p>{<Inline text={`Click [here](${href}) now`} />}</p>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).toBe('Click here now');
    expect(container.innerHTML).not.toMatch(/javascript:|data:|vbscript:/i);
  });

  it('keeps an unmatched mark as text', () => {
    const { container } = render(<p>{<Inline text="a `b and **c and [d](no close" />}</p>);
    expect(container.textContent).toBe('a `b and **c and [d](no close');
    expect(container.querySelector('code, strong, a')).toBeNull();
  });
});

describe('DocBlocks', () => {
  it('renders paragraphs, ordered and unordered lists, and subheadings with their ids', () => {
    const { container } = render(
      <DocBlocks
        blocks={[
          { kind: 'paragraph', text: 'First `para`.' },
          { kind: 'ordered', items: ['one', 'two', 'three'] },
          { kind: 'list', items: ['alpha', 'beta'] },
          { kind: 'subheading', id: 'deep-link', text: 'A **sub** heading' },
        ]}
      />,
    );
    expect(container.querySelector('p')?.textContent).toBe('First para.');
    expect([...container.querySelectorAll('ol > li')].map((li) => li.textContent)).toEqual(['one', 'two', 'three']);
    expect([...container.querySelectorAll('ul > li')].map((li) => li.textContent)).toEqual(['alpha', 'beta']);
    const h3 = screen.getByRole('heading', { level: 3, name: 'A sub heading' });
    expect(h3.id).toBe('deep-link');
  });

  it('labels each callout with an icon and text, not color alone', () => {
    render(
      <DocBlocks
        blocks={[
          { kind: 'callout', tone: 'note', text: 'A note.' },
          { kind: 'callout', tone: 'warning', text: 'A warning.' },
          { kind: 'callout', tone: 'limit', text: 'A limit.' },
        ]}
      />,
    );
    const notes = screen.getAllByRole('note');
    expect(notes.map((n) => n.getAttribute('data-callout'))).toEqual(['note', 'warning', 'limit']);
    expect(notes.map((n) => within(n).getByText(/^(Note|Warning|Limitation)$/).textContent)).toEqual(['Note', 'Warning', 'Limitation']);
    for (const n of notes) {
      const icon = n.querySelector('svg');
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('puts a table in a focusable, labelled scroll region with its caption and header cells', () => {
    render(<DocBlocks blocks={[{ kind: 'table', caption: 'Keys', head: ['Key', 'Purpose'], rows: [['`APP_MODE`', 'demo or live']] }]} />);
    const region = screen.getByRole('region', { name: 'Keys' });
    expect(region.getAttribute('tabindex')).toBe('0');
    const table = within(region).getByRole('table', { name: 'Keys' });
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Key', 'Purpose']);
    expect(within(table).getByText('APP_MODE').tagName).toBe('CODE');
  });

  it('renders a code block with caption and language, scrolling inside its region, and copies it for real', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const code = 'npm ci\nnpm run setup';
    render(<DocBlocks blocks={[{ kind: 'code', language: 'bash', caption: 'Install and configure', code }]} />);
    const figure = screen.getByRole('figure', { name: 'Install and configure' });
    expect(within(figure).getByText('bash')).toBeTruthy();
    const region = within(figure).getByRole('region', { name: 'Install and configure' });
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.querySelector('pre code')?.textContent).toBe(code);

    const button = within(figure).getByRole('button', { name: 'Copy code: Install and configure' });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith(code);
    expect(button.textContent).toContain('Copied');
  });
});
