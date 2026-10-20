/**
 * JsonView (design spec §6 "JSON payloads in a styled code panel"): a redacted payload as a
 * recessed code well with a header (file-style label, Redacted chip, size, copy button) and a
 * syntax-colored, collapsible tree. Tokens are React nodes (never dangerouslySetInnerHTML). Keys,
 * strings, numbers and booleans take the categorical chart steps (never status hues), null and
 * punctuation stay neutral, and the redaction marker is a neutral inset chip that keeps its
 * "[REDACTED]" text so a copy still says what was removed. Objects and arrays are native
 * <details> disclosures (keyboard and screen reader support, no JS); a closed one previews its
 * size. The body scrolls inside a max height as a focusable region (ScrollRegion), with a fade at
 * the bottom edge only while more content is below, so a short payload ends cleanly. Given a
 * `flex-1` className the well fills a stretched card (the empty part reads as blank editor lines).
 * Server-safe; only the copy button and the scroll fade are client islands.
 */
import type { ReactNode } from 'react';
import { Braces, ChevronRight, Lock } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { CopyButton } from './CopyButton';
import { ScrollRegion } from './ScrollRegion';

const REDACTED_MARK = '[REDACTED]';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const PUNCT = 'text-fg-3';
const KEY = 'text-chart-1-hi';
const STRING = 'text-chart-2-hi';
const NUMBER = 'text-chart-3-hi';
const BOOLEAN = 'text-chart-4-hi';

function normalize(value: unknown): { data: Json; text: string } | null {
  try {
    const text = JSON.stringify(value, null, 2);
    if (text === undefined) return null;
    return { data: JSON.parse(text) as Json, text };
  } catch {
    return null;
  }
}

function formatBytes(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function StringToken({ value }: { value: string }) {
  const quoted = JSON.stringify(value);
  const parts = quoted.split(REDACTED_MARK);
  return (
    <span className={STRING}>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 ? (
            <span data-json-redacted="" className="mx-px rounded-sm bg-bg-3 px-1 text-fg-2 ring-1 ring-border-strong ring-inset">
              {REDACTED_MARK}
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

function Primitive({ value }: { value: Exclude<Json, Json[] | { [key: string]: Json }> }) {
  if (value === null) return <span className="text-fg-3 italic">null</span>;
  if (typeof value === 'boolean') return <span className={BOOLEAN}>{String(value)}</span>;
  if (typeof value === 'number') return <span className={NUMBER}>{String(value)}</span>;
  return <StringToken value={value} />;
}

function KeyLabel({ name }: { name: string | null }) {
  if (name === null) return null;
  return (
    <>
      <span className={KEY}>{JSON.stringify(name)}</span>
      <span className={PUNCT}>: </span>
    </>
  );
}

function Comma({ show }: { show: boolean }) {
  return show ? <span className={PUNCT}>,</span> : null;
}

function JsonNode(props: { name: string | null; value: Json; depth: number; last: boolean; openDepth: number }) {
  const { name, value, depth, last } = props;
  const line = 'whitespace-pre-wrap [overflow-wrap:anywhere]';
  if (value === null || typeof value !== 'object') {
    return (
      <div className={line}>
        <KeyLabel name={name} />
        <Primitive value={value} />
        <Comma show={!last} />
      </div>
    );
  }
  const isArray = Array.isArray(value);
  const entries: Array<[string | null, Json]> = isArray ? value.map((v) => [null, v]) : Object.entries(value);
  const [open, close] = isArray ? ['[', ']'] : ['{', '}'];
  if (entries.length === 0) {
    return (
      <div className={line}>
        <KeyLabel name={name} />
        <span className={PUNCT}>
          {open}
          {close}
        </span>
        <Comma show={!last} />
      </div>
    );
  }
  const size = isArray ? `${entries.length} ${entries.length === 1 ? 'item' : 'items'}` : `${entries.length} ${entries.length === 1 ? 'key' : 'keys'}`;
  return (
    <details open={depth < props.openDepth} className="[&[open]>summary_[data-json-chevron]]:rotate-90 [&[open]>summary_[data-json-preview]]:hidden">
      <summary className={cn('-ml-5 flex w-fit max-w-full cursor-pointer list-none items-start rounded-sm pr-1 hover:bg-bg-2/70 [&::-webkit-details-marker]:hidden', line)}>
        <span aria-hidden="true" className="flex h-6 w-5 shrink-0 items-center justify-center text-fg-3">
          <ChevronRight data-json-chevron="" className="size-3.5 motion-safe:transition-transform motion-safe:duration-fast" />
        </span>
        <span>
          <KeyLabel name={name} />
          <span className={PUNCT}>{open}</span>
          <span data-json-preview="">
            <span className="mx-1 rounded-sm bg-bg-3 px-1 text-fg-2">{size}</span>
            <span className={PUNCT}>{close}</span>
            <Comma show={!last} />
          </span>
        </span>
      </summary>
      <div className="ml-[0.3rem] border-l border-border-subtle pl-[1.2rem]">
        {entries.map(([key, child], i) => (
          <JsonNode key={key ?? i} name={key} value={child} depth={depth + 1} last={i === entries.length - 1} openDepth={props.openDepth} />
        ))}
      </div>
      <div className={line}>
        <span className={PUNCT}>{close}</span>
        <Comma show={!last} />
      </div>
    </details>
  );
}

export function JsonView(props: {
  value: unknown;
  /** File-style label in the header and the copy button's name, e.g. "payload.json". */
  label: string;
  /** Shows the Redacted chip: the value already passed through the server's redaction. */
  redacted?: boolean;
  /** Extra header facts, e.g. the payload version. */
  meta?: ReactNode;
  /** Objects nested deeper than this start closed (default 3). */
  openDepth?: number;
  className?: string;
}) {
  const normalized = normalize(props.value);
  const text = normalized?.text ?? String(props.value);
  const lines = text.split('\n').length;
  return (
    <div data-json-view="" className={cn('flex min-w-0 flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-0', props.className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-subtle bg-bg-2/70 py-1.5 pr-1.5 pl-3">
        <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-md bg-panel/14 text-panel">
          <Braces className="size-3.5" />
        </span>
        <span className="font-mono text-xs text-fg-1">{props.label}</span>
        {props.redacted ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-bg-3 px-2 py-0.5 text-[11px] leading-4 font-medium text-fg-2">
            <Lock aria-hidden="true" className="size-3" />
            Redacted
          </span>
        ) : null}
        {props.meta ? <span className="text-xs text-fg-2">{props.meta}</span> : null}
        <span className="tabular ml-auto text-xs text-fg-2">
          {formatBytes(text)} · {lines} {lines === 1 ? 'line' : 'lines'}
        </span>
        <CopyButton value={text} label={props.label} />
      </div>
      <ScrollRegion label={`${props.label} contents`} className="max-h-[28rem] overflow-auto py-3 pr-3 pl-7 font-mono text-xs leading-6 text-fg-1" fadeClassName="from-bg-0">
        {normalized ? <JsonNode name={null} value={normalized.data} depth={0} last openDepth={props.openDepth ?? 3} /> : <div className="whitespace-pre-wrap">{text}</div>}
      </ScrollRegion>
    </div>
  );
}
