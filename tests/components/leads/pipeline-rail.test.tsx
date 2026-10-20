/**
 * Lead detail pipeline (employee report bug 3: "Skipped NO_SENDABLE_DRAFT" on screen): every
 * reason code a pipeline stage can store reads as a sentence, never as the raw code, including
 * codes added later (generic sentence). Each step keeps data-stage on the element that holds its
 * outcome label, and the outcome is icon + label (never color alone). The stage reason codes are
 * read from the stage sources so a new code cannot ship without a label.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PipelineRail } from '@/components/leads/PipelineRail';
import { RUN_REASONS, runReasonText } from '@/components/leads/lead-vocabulary';

afterEach(cleanup);

const PIPELINE_DIR = path.resolve(import.meta.dirname, '../../../src/server/services/pipeline');

/** reasonCode literals in the stage handlers and the executor (the values a PipelineStageRun can hold). */
function storedReasonCodes(): string[] {
  const files = [...readdirSync(path.join(PIPELINE_DIR, 'stages')).map((f) => path.join(PIPELINE_DIR, 'stages', f)), path.join(PIPELINE_DIR, 'executor.ts'), path.join(PIPELINE_DIR, 'config.ts')];
  const codes = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/reasonCode:\s*'([A-Z_]+)'/g)) codes.add(m[1]!);
    for (const m of source.matchAll(/'(STAGE_[A-Z_]+)'/g)) codes.add(m[1]!);
  }
  return [...codes];
}

describe('PipelineRail', () => {
  it('has a plain-language sentence for every reason code the pipeline stores', () => {
    const codes = storedReasonCodes();
    expect(codes).toEqual(expect.arrayContaining(['NO_SENDABLE_DRAFT', 'NOTHING_APPROVED', 'AWAITING_HUMAN_APPROVAL', 'STAGE_HANDLER_MISSING', 'STAGE_ERROR']));
    for (const code of codes.filter((c) => !['STAGE_NOT_IN_PIPELINE', 'STAGE_OUT_OF_ORDER'].includes(c))) {
      expect(RUN_REASONS[code], code).toBeTruthy();
    }
    expect(runReasonText('SOMETHING_NEW')).not.toContain('SOMETHING_NEW');
  });

  it('renders each step with its outcome as icon + label and the reason in words', () => {
    const { container } = render(
      <PipelineRail
        steps={[
          { stage: 'INGESTION', status: 'DONE', reasonCode: null },
          { stage: 'SCORE', status: 'DONE', reasonCode: null },
          { stage: 'DRAFT', status: 'DONE', reasonCode: null },
          { stage: 'APPROVAL', status: 'SKIPPED', reasonCode: 'NO_SENDABLE_DRAFT' },
          { stage: 'DELIVERY', status: 'SKIPPED', reasonCode: 'NOTHING_APPROVED' },
        ]}
      />,
    );
    const draft = container.querySelector('[data-stage="DRAFT"]') as HTMLElement;
    expect(draft.textContent).toContain('Done');
    const doneChip = Array.from(draft.querySelectorAll('[data-tone]')).find((el) => el.textContent === 'Done') as HTMLElement;
    expect(doneChip.getAttribute('data-tone')).toBe('success');
    expect(doneChip.querySelector('svg')).not.toBeNull();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/NO_SENDABLE_DRAFT|NOTHING_APPROVED/);
    expect(text).toContain(RUN_REASONS.NO_SENDABLE_DRAFT);
    expect(text).toContain('Nothing was approved for delivery.');
    expect(container.querySelectorAll('ol > li')).toHaveLength(5);
  });

  it('fills the connector after a finished step and dashes it after a skipped one', () => {
    const { container } = render(
      <PipelineRail
        steps={[
          { stage: 'INGESTION', status: 'DONE', reasonCode: null },
          { stage: 'SCORE', status: 'DONE', reasonCode: null },
          { stage: 'DRAFT', status: 'DONE', reasonCode: null },
          { stage: 'APPROVAL', status: 'SKIPPED', reasonCode: 'NO_SENDABLE_DRAFT' },
          { stage: 'DELIVERY', status: 'PENDING', reasonCode: null },
        ]}
      />,
    );
    const connectors = Array.from(container.querySelectorAll('[data-connector]')).map((c) => c.getAttribute('data-connector'));
    // No connector after the last step.
    expect(connectors).toEqual(['done', 'done', 'done', 'skipped']);
    const skipped = container.querySelector('[data-connector="skipped"]') as HTMLElement;
    expect(skipped.className).toContain('border-dashed');
    expect(skipped.className).not.toContain('--panel-grad');
  });
});
