/**
 * Shared lead vocabulary and chips: who wrote a draft or message (one vocabulary for the lead
 * detail and the approval queue; only anthropic/openai are AI), sales stages as icon + label
 * chips, the score meter as a decorative bar beside the score text, and the review reasons as
 * sentences (the sanity cap named from the stored value, unknown codes never shown raw).
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { GeneratorChip } from '@/components/leads/GeneratorChip';
import { ScoreMeter } from '@/components/leads/ScoreMeter';
import { StageChip } from '@/components/leads/StageChip';
import { reviewReasonText, SALES_STAGE_VOCABULARY } from '@/components/leads/lead-vocabulary';
import { generatorInfo } from '@/lib/schemas/lead-console';
import { SalesStage } from '@/lib/domain/enums';

afterEach(cleanup);

describe('generator vocabulary', () => {
  it('only real model providers are AI', () => {
    expect(generatorInfo('anthropic')).toMatchObject({ kind: 'ai', short: 'AI prepared' });
    expect(generatorInfo('openai')).toMatchObject({ kind: 'ai', short: 'AI prepared' });
    expect(generatorInfo('local-deterministic')).toMatchObject({ kind: 'template', label: 'Local template (deterministic)' });
    expect(generatorInfo('reply-guard').kind).toBe('automatic');
    expect(generatorInfo('system').kind).toBe('system');
    expect(generatorInfo('human').kind).toBe('human');
    expect(generatorInfo(null).kind).toBe('none');
    expect(generatorInfo('some-new-model')).toEqual({ kind: 'other', label: 'some-new-model', short: 'some-new-model' });
  });

  it('GeneratorChip renders nothing for a person or no generator', () => {
    const { container, rerender } = render(<GeneratorChip generatorLabel="human" />);
    expect(container.textContent).toBe('');
    rerender(<GeneratorChip generatorLabel={null} />);
    expect(container.textContent).toBe('');
    rerender(<GeneratorChip generatorLabel="local-deterministic" />);
    expect(container.textContent).toBe('Local template');
    expect(container.querySelector('[data-generator="template"] svg')).not.toBeNull();
  });
});

describe('StageChip and ScoreMeter', () => {
  it('every sales stage is an icon + label chip', () => {
    for (const stage of SalesStage) {
      const { container, unmount } = render(<StageChip stage={stage} />);
      const chip = container.querySelector(`[data-sales-stage="${stage}"]`) as HTMLElement;
      expect(chip.textContent).toBe(SALES_STAGE_VOCABULARY[stage]!.label);
      expect(chip.querySelector('svg')).not.toBeNull();
      expect(chip.tagName).not.toBe('A');
      unmount();
    }
  });

  it('the meter is decorative and fills to the score share of the full ramp', () => {
    const { container, rerender } = render(<ScoreMeter value={49} />);
    const meter = container.querySelector('[data-score-meter]') as HTMLElement;
    expect(meter.getAttribute('aria-hidden')).toBe('true');
    expect(meter.textContent).toBe('');
    const fill = meter.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe('49%');
    rerender(<ScoreMeter value={null} />);
    expect((container.querySelector('[data-score-meter]') as HTMLElement).childElementCount).toBe(0);
    rerender(<ScoreMeter value={140} />);
    expect(((container.querySelector('[data-score-meter]') as HTMLElement).firstElementChild as HTMLElement).style.width).toBe('100%');
  });
});

describe('review reasons', () => {
  it('names the stored sanity cap and never shows an unknown code', () => {
    expect(reviewReasonText({ code: 'TOTAL_ABOVE_SANITY_CAP', totalPaise: '20000000000', capPaise: '5000000000' })).toBe('The total is above the ₹5,00,00,000.00 review limit.');
    expect(reviewReasonText('PRICE_MISSING')).toBe('A service has no price in the active price list.');
    expect(reviewReasonText({ code: 'PRICE_MISSING', serviceId: 's1' })).toBe('A service has no price in the active price list.');
    expect(reviewReasonText('BRAND_NEW_CODE')).not.toContain('BRAND_NEW_CODE');
    expect(reviewReasonText(null)).toBe('Needs a review before approval.');
  });
});
