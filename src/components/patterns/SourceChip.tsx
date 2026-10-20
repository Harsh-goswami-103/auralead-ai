/**
 * SourceChip (design spec §6): a lead source as a category chip, colored dot or icon plus the text
 * label (never color alone), in the shared source palette from source-style.ts. Server-safe.
 */
import { cn } from '@/components/ui/cn';
import { sourceStyle } from './source-style';

export function SourceChip(props: { source: string; className?: string; withIcon?: boolean }) {
  const style = sourceStyle(props.source);
  const Icon = style.icon;
  return (
    <span
      data-source-chip={props.source}
      className={cn('inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', style.chipClass, props.className)}
    >
      {props.withIcon ? (
        <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', style.iconClass)} />
      ) : (
        <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', style.dotClass)} />
      )}
      {style.label}
    </span>
  );
}
