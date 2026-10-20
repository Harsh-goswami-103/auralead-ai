/**
 * ProviderChip: a webhook provider as a category chip (icon + readable name, never a raw enum or a
 * brand logo) in the shared source palette, so Meta, Sheets, Maps and WhatsApp keep the colors
 * they have as lead sources. Server-safe.
 */
import { cn } from '@/components/ui/cn';
import { providerStyle } from './admin-vocabulary';

export function ProviderChip(props: { provider: string; className?: string }) {
  const style = providerStyle(props.provider);
  const Icon = style.icon;
  return (
    <span
      data-provider-chip={props.provider}
      className={cn('inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', style.chipClass, props.className)}
    >
      <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', style.iconClass)} />
      {style.label}
    </span>
  );
}

/** A larger provider glyph tile for headers (decorative; the name is always printed beside it). */
export function ProviderGlyph(props: { provider: string; className?: string }) {
  const style = providerStyle(props.provider);
  const Icon = style.icon;
  return (
    <span aria-hidden="true" className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl border', style.chipClass, props.className)}>
      <Icon className={cn('size-5', style.iconClass)} />
    </span>
  );
}
