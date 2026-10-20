/**
 * The block renderer for a docs section (content/docs/format.ts). Paragraphs, lists, subheadings
 * (h3 with their anchor id), callouts (an icon and a text label per tone: Note, Warning,
 * Limitation; status hues only, never decoration), tables and code blocks. Tables and code blocks
 * scroll inside a focusable, labelled region, so a long line never widens the page at 390 px. A
 * code block shows its caption and language, and a Copy button (the shared CopyButton client
 * island, which really writes to the clipboard). Server-safe; text goes through Inline only.
 */
import { useId } from 'react';
import { Ban, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { CalloutTone, DocBlock } from '@content/docs/format';
import { CopyButton } from '@/components/admin/CopyButton';
import { ScrollRegion } from '@/components/client/ScrollRegion';
import { cn } from '@/components/ui/cn';
import { Inline } from './Inline';

const CALLOUT: Readonly<Record<CalloutTone, { label: string; icon: LucideIcon; box: string; icon_: string }>> = {
  note: { label: 'Note', icon: Info, box: 'border-info/35 bg-info/8', icon_: 'text-info' },
  warning: { label: 'Warning', icon: TriangleAlert, box: 'border-warning/40 bg-warning/8', icon_: 'text-warning' },
  limit: { label: 'Limitation', icon: Ban, box: 'border-border-strong bg-bg-2/70', icon_: 'text-fg-2' },
};

const LANGUAGE_LABEL: Readonly<Record<Extract<DocBlock, { kind: 'code' }>['language'], string>> = {
  bash: 'bash',
  powershell: 'PowerShell',
  env: '.env',
  text: 'text',
};

function Callout({ tone, text }: { tone: CalloutTone; text: string }) {
  const c = CALLOUT[tone];
  const Icon = c.icon;
  return (
    <div role="note" data-callout={tone} className={cn('flex gap-3 rounded-lg border px-3 py-2.5 text-sm text-fg-1', c.box)}>
      <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', c.icon_)} />
      <p className="min-w-0 [overflow-wrap:anywhere]">
        <strong className="font-semibold">{c.label}</strong>
        <span className="sr-only">: </span> <Inline text={text} />
      </p>
    </div>
  );
}

function CodeBlock({ block }: { block: Extract<DocBlock, { kind: 'code' }> }) {
  const captionId = useId();
  return (
    <figure aria-labelledby={captionId} className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-0/80">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle bg-bg-2/60 px-3 py-1.5">
        <figcaption id={captionId} className="min-w-0 text-xs font-medium text-fg-1 [overflow-wrap:anywhere]">
          {block.caption}
        </figcaption>
        <span className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-fg-2">{LANGUAGE_LABEL[block.language]}</span>
          <CopyButton value={block.code} label={`code: ${block.caption}`} showText />
        </span>
      </div>
      <ScrollRegion label={block.caption} className="rounded-none">
        <pre className="w-max min-w-full px-3 py-2.5 font-mono text-[13px] leading-5 text-fg-1">
          <code>{block.code}</code>
        </pre>
      </ScrollRegion>
    </figure>
  );
}

function Table({ block }: { block: Extract<DocBlock, { kind: 'table' }> }) {
  return (
    <ScrollRegion label={block.caption} className="rounded-lg border border-border-subtle">
      <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
        <caption className="border-b border-border-subtle px-3 py-2 text-left text-xs font-medium text-fg-2">{block.caption}</caption>
        <thead className="bg-bg-2/60 text-xs text-fg-2">
          <tr>
            {block.head.map((h, i) => (
              <th key={i} scope="col" className="px-3 py-2 font-medium">
                <Inline text={h} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r} className="border-t border-border-subtle align-top">
              {row.map((cell, c) => (
                <td key={c} className="px-3 py-2 text-fg-1 [overflow-wrap:anywhere]">
                  <Inline text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

function Block({ block }: { block: DocBlock }) {
  switch (block.kind) {
    case 'paragraph':
      return (
        <p className="max-w-prose text-fg-1 [overflow-wrap:anywhere]">
          <Inline text={block.text} />
        </p>
      );
    case 'list':
      return (
        <ul className="flex max-w-prose list-disc flex-col gap-1.5 pl-5 text-fg-1 marker:text-fg-3 [overflow-wrap:anywhere]">
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline text={item} />
            </li>
          ))}
        </ul>
      );
    case 'ordered':
      return (
        <ol className="flex max-w-prose list-decimal flex-col gap-1.5 pl-5 text-fg-1 marker:text-fg-2 [overflow-wrap:anywhere]">
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline text={item} />
            </li>
          ))}
        </ol>
      );
    case 'subheading':
      return (
        <h3 id={block.id} className="scroll-mt-24 pt-1 font-display text-md font-semibold text-fg-1">
          <Inline text={block.text} />
        </h3>
      );
    case 'callout':
      return <Callout tone={block.tone} text={block.text} />;
    case 'table':
      return <Table block={block} />;
    case 'code':
      return <CodeBlock block={block} />;
  }
}

export function DocBlocks({ blocks }: { blocks: readonly DocBlock[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}
