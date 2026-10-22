/**
 * T37: the account menu links to the documentation. Opening the menu shows a "Documentation"
 * item that is a real link to /docs, placed before "Sign out".
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { UserMenu } from '@/components/patterns/UserMenu';

afterEach(cleanup);

describe('UserMenu documentation link', () => {
  it('lists Documentation as a link to /docs before Sign out', async () => {
    render(<UserMenu user={{ name: 'Ananya Sharma', email: 'owner@demo.auralead.test', role: 'USER', isDemo: true }} />);
    const trigger = screen.getByRole('button', { name: /^AS, account/ });
    await act(async () => {
      fireEvent.keyDown(trigger, { key: 'Enter' });
    });
    const items = await screen.findAllByRole('menuitem');
    const names = items.map((i) => i.textContent?.trim());
    expect(names).toEqual(['Documentation', 'Sign out']);
    const docs = items[0]!;
    expect(docs.tagName).toBe('A');
    expect(docs.getAttribute('href')).toBe('/docs');
  });
});
