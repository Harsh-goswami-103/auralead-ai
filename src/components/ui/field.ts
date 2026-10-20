/**
 * Shared field surface for Input, Textarea and NativeSelect (design spec §5): solid bg-2 with the
 * solid input border (>= 3:1, WCAG 1.4.11), 16px text below md so iOS never zooms on focus, color
 * only on focus (the global 2px aura outline) and on aria-invalid (danger border). Inputs stay
 * neutral otherwise (spec §7).
 */
export const fieldSurface =
  'w-full min-w-0 rounded-md border border-input bg-bg-2 text-md text-fg-1 caret-cyan transition-[border-color,background-color] duration-fast ease-enter placeholder:text-fg-3 hover:not-aria-invalid:border-fg-3 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger md:text-sm';
