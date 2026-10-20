/**
 * Version diff (T22, F18; employee report): every change is named in words and carries a marker
 * and its own tone (added success, removed danger, changed warning, unchanged neutral), a changed
 * value reads "from X to Y" for screen readers, and a discount of zero reads "None" instead of
 * "-₹0.00". The total change is stated with its sign; money is never colored.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { VersionDiff } from '@/components/approvals/VersionDiff';
import type { VersionDiff as Diff } from '@/server/services/approvals/queue';

afterEach(cleanup);

const diff: Diff = {
  fromVersionNo: 1,
  toVersionNo: 2,
  previousApproval: 'INVALIDATED',
  lines: [
    { serviceId: 's1', name: 'Consultation', change: 'SAME', fromQty: 1, toQty: 1, fromUnitPricePaise: 80_000n, toUnitPricePaise: 80_000n, fromLineTotalPaise: 80_000n, toLineTotalPaise: 80_000n },
    { serviceId: 's2', name: 'Whitening', change: 'CHANGED', fromQty: 1, toQty: 2, fromUnitPricePaise: 850_000n, toUnitPricePaise: 850_000n, fromLineTotalPaise: 850_000n, toLineTotalPaise: 1_700_000n },
    { serviceId: 's3', name: 'X-ray', change: 'ADDED', fromQty: null, toQty: 1, fromUnitPricePaise: null, toUnitPricePaise: 50_000n, fromLineTotalPaise: null, toLineTotalPaise: 50_000n },
    { serviceId: 's4', name: 'Scaling', change: 'REMOVED', fromQty: 1, toQty: null, fromUnitPricePaise: 150_000n, toUnitPricePaise: null, fromLineTotalPaise: 150_000n, toLineTotalPaise: null },
  ],
  discount: { from: 0n, to: 50_000n },
  tax: { from: 162_000n, to: 300_000n },
  totals: { from: 1_242_000n, to: 2_080_000n },
};

describe('VersionDiff', () => {
  it('names each change in words with a marker and its tone, keeping data-diff-change', () => {
    render(<VersionDiff diff={diff} />);
    const expected = { SAME: ['Unchanged', 'text-fg-2'], CHANGED: ['Changed', 'text-warning'], ADDED: ['Added', 'text-success'], REMOVED: ['Removed', 'text-danger'] } as const;
    for (const [change, [word, tone]] of Object.entries(expected)) {
      const row = document.querySelector(`[data-diff-change="${change}"]`) as HTMLElement;
      expect(row).not.toBeNull();
      const chip = Array.from(row.querySelectorAll('span')).find((s) => s.textContent === word);
      expect(chip, change).toBeTruthy();
      expect(chip!.className).toContain(tone);
      expect(chip!.querySelector('svg')).not.toBeNull();
    }
    expect(document.querySelector('[data-version-diff]')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('v2 (current) against v1 (approved or waiting, now invalidated)');
  });

  it('a changed value reads "from X to Y"; a removed line is struck through', () => {
    render(<VersionDiff diff={diff} />);
    const changed = document.querySelector('[data-diff-change="CHANGED"]') as HTMLElement;
    expect(changed.textContent).toContain('from 1 to 2');
    expect(changed.textContent).toContain('from ₹8,500.00 to ₹17,000.00');
    const removed = document.querySelector('[data-diff-change="REMOVED"]') as HTMLElement;
    expect(removed.querySelector('td')!.className).toContain('line-through');
  });

  it('a zero discount reads "None", never "-₹0.00"; the total change has its sign', () => {
    render(<VersionDiff diff={diff} />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('from None to −₹500.00');
    expect(text).not.toContain('-₹0.00');
    expect(text).toContain('Total +₹8,380.00');
  });
});
