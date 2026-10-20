/**
 * T28 React Flow canvas (06-design F13, §11.8 licensing): one node per stage in run order with its
 * readiness, a connection the validator rejected drawn with its reason on the edge itself, the
 * React Flow attribution kept visible, and clicking a stage selects it in the editor. jsdom lacks
 * the layout APIs React Flow measures with, so they are stubbed the way the React Flow docs
 * describe for tests.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PipelineCanvas } from '@/components/pipeline/PipelineCanvas';
import { connect, defaultGraph } from '@/components/pipeline/pipeline-model';

class ResizeObserverStub {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(target: Element) {
    this.cb([{ target, contentRect: { width: 1000, height: 320 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {
    return undefined;
  }
  disconnect() {
    return undefined;
  }
}

class DOMMatrixReadOnlyStub {
  m22: number;
  constructor(transform: string) {
    const scale = transform?.match(/scale\(([1-9.])\)/)?.[1];
    this.m22 = scale !== undefined ? Number(scale) : 1;
  }
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyStub);
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get: () => 80 },
    offsetWidth: { configurable: true, get: () => 180 },
  });
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 60, height: 14 }) as DOMRect;
});

afterEach(() => cleanup());

describe('PipelineCanvas', () => {
  it('draws one node per stage with readiness, the rejected edge with its reason, and the attribution', async () => {
    const added = connect(defaultGraph(), 'draft', 'score');
    if (!added.ok) throw new Error('unexpected refusal');
    const onSelect = vi.fn();
    await act(async () => {
      render(
        <PipelineCanvas
          graph={added.graph}
          issues={[
            { code: 'CYCLE', message: 'loop' },
            { code: 'STAGE_ORDER', message: 'order', edge: { from: 'draft', to: 'score' } },
          ]}
          readiness={{ DRAFT: { label: 'Local generator (DEMO)', tone: 'demo' } }}
          selectedId={null}
          editable
          onConnect={vi.fn()}
          onDisconnect={vi.fn()}
          onSelect={onSelect}
        />,
      );
    });
    const nodes = [...document.querySelectorAll('[data-stage-node]')].map((n) => n.getAttribute('data-stage-node'));
    expect(nodes).toEqual(['INGESTION', 'SCORE', 'DRAFT', 'APPROVAL', 'DELIVERY']);
    expect(screen.getByText('Local generator (DEMO)')).toBeTruthy();
    expect(screen.getByText('Score cannot come after Draft: stages run in their fixed order.')).toBeTruthy();
    expect(document.querySelector('.react-flow__attribution')).not.toBeNull();

    const draftNode = document.querySelector('[data-stage-node="DRAFT"]')!;
    await act(async () => fireEvent.click(draftNode));
    expect(onSelect).toHaveBeenCalledWith('draft');
  });
});
