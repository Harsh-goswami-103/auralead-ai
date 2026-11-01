import { describe, expect, it } from 'vitest';
import { isSafeRedirect } from '@/components/patterns/api-client';

describe('isSafeRedirect', () => {
  it.each(['/', '/login', '/dashboard/user/quotations?id=123', '/?next=%2Fdashboard', '/#overview'])('accepts same-origin path %s', (path) => {
    expect(isSafeRedirect(path)).toBe(true);
  });

  it.each(['', 'dashboard', 'https://evil.example/', '//evil.example/', '///evil.example/', '/\\evil.example/', '/\\/evil.example/', '/\t/evil.example/', '/\n/evil.example/', '/\r/evil.example/', '/\t\\evil.example/', 'javascript:alert(1)', null, undefined, 42, {}])('rejects unsafe redirect %s', (path) => {
    expect(isSafeRedirect(path)).toBe(false);
  });
});
