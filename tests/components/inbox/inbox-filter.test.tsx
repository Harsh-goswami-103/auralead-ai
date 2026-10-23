/**
 * The inbox's All / Needs you / Handed over filter (design spec §0.5; ADR-124): plain links with
 * aria-current on the current filter, the server's counts in words, touch targets of at least 44px
 * below 1024px (36px pills from lg, where a pointer is assumed), and the operator's `[ws]` inbox
 * through `basePath`.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InboxFilter } from '@/components/inbox/InboxFilter';

afterEach(() => cleanup());

describe('InboxFilter', () => {
  it('links each filter with its count, marks the current one and keeps 44px targets below lg', () => {
    render(<InboxFilter current="needs_you" counts={{ all: 9, needsYou: 2, handedOver: 1 }} />);
    const nav = screen.getByRole('navigation', { name: 'Inbox filter' });
    const links = nav.querySelectorAll('a');
    expect(links).toHaveLength(3);
    expect(links[0]!.getAttribute('href')).toBe('/dashboard/user/inbox');
    expect(links[0]!.textContent).toBe('All(9)');
    expect(links[1]!.getAttribute('aria-current')).toBe('page');
    expect(links[1]!.textContent).toBe('Needs you(2)');
    expect(links[2]!.getAttribute('href')).toBe('/dashboard/user/inbox?filter=handed_over');
    expect(links[2]!.textContent).toBe('Handed over(1)');
    for (const link of links) {
      expect(link.className).toMatch(/(^| )min-h-11( |$)/);
      expect(link.className).toContain('lg:min-h-9');
    }
  });

  it('links into the operator inbox of one workspace', () => {
    render(<InboxFilter current="all" counts={{ all: 1, needsYou: 0, handedOver: 0 }} basePath="/dashboard/employee/codecraft-web/inbox" />);
    const links = screen.getByRole('navigation', { name: 'Inbox filter' }).querySelectorAll('a');
    expect([...links].map((a) => a.getAttribute('href'))).toEqual([
      '/dashboard/employee/codecraft-web/inbox',
      '/dashboard/employee/codecraft-web/inbox?filter=needs_you',
      '/dashboard/employee/codecraft-web/inbox?filter=handed_over',
    ]);
  });
});
