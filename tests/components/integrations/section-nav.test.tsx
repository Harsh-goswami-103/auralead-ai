/**
 * Adversarial review: at 390 px the sections row scrolls inside itself, and each page mounts it at
 * the start. The current section must be brought into view, or the highlighted "you are here" tab
 * is off-screen on Pipeline, Sheets, Meta and Extension.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSectionNav } from '@/components/integrations/WorkspaceSectionNav';

const pathname = '/dashboard/employee/codecraft-web/pipeline';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));
afterEach(cleanup);

describe('WorkspaceSectionNav', () => {
  it('scrolls the current section to the middle of the row', () => {
    const offsetLeft = vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('aria-current') === 'page' ? 640 : 0;
    });
    const offsetWidth = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('aria-current') === 'page' ? 100 : 0;
    });
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(358);
    render(<WorkspaceSectionNav slug="codecraft-web" workspaceName="Codecraft Web Studio" />);
    const nav = screen.getByRole('navigation', { name: 'Codecraft Web Studio sections' });
    expect(nav.scrollLeft).toBe(640 - (358 - 100) / 2);
    expect(screen.getByRole('link', { name: /Pipeline/ }).getAttribute('aria-current')).toBe('page');
    offsetLeft.mockRestore();
    offsetWidth.mockRestore();
    clientWidth.mockRestore();
  });
});
