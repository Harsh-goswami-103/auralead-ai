/**
 * Visible metric definitions under a table (06-design §11.1 "each metric has a definition
 * footnote"; P10). Each entry is numbered and carries an id, so a column header can point at it
 * with a footnote link. Server-safe.
 */
import { cn } from '@/components/ui/cn';

export function definitionAnchor(prefix: string, id: string): string {
  return `${prefix}-def-${id}`;
}

export function DefinitionList(props: { title: string; prefix: string; items: ReadonlyArray<{ id: string; label: string; definition: string }>; className?: string }) {
  return (
    <section aria-label={props.title} className={cn('flex flex-col gap-2 rounded-lg border border-border-subtle bg-bg-0/40 p-3 sm:p-4', props.className)}>
      <h3 className="text-xs font-medium tracking-[0.08em] text-fg-2 uppercase">{props.title}</h3>
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-fg-2 marker:text-fg-3">
        {props.items.map((item) => (
          <li key={item.id} id={definitionAnchor(props.prefix, item.id)} className="scroll-mt-24">
            <span className="font-medium text-fg-1">{item.label}:</span> {item.definition}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A superscript link from a column header to its numbered definition. */
export function FootnoteRef(props: { prefix: string; id: string; n: number; label: string }) {
  return (
    <sup className="ml-0.5">
      <a href={`#${definitionAnchor(props.prefix, props.id)}`} aria-label={`Definition of ${props.label}`} className="rounded-sm px-0.5 text-cyan underline-offset-2 hover:underline">
        {props.n}
      </a>
    </sup>
  );
}
