/**
 * GlowFrame (design spec §3, color report "primary button"): wraps the ONE primary CTA of a view
 * and adds a soft aura glow on hover and keyboard focus. The glow lives here, not in the Button,
 * so the ESLint glow rule keeps every other surface flat. CSS only and server-safe; the glow
 * appears without a transition under reduced motion. Match `className` radius to the button.
 */
import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export function GlowFrame(props: { children: ReactNode; className?: string }) {
  return (
    <span
      data-glow-frame=""
      className={cn(
        'inline-flex rounded-md transition-shadow duration-150 ease-enter motion-reduce:transition-none',
        'hover:shadow-[0_8px_28px_-10px_color-mix(in_oklab,var(--aura)_55%,transparent)]',
        '[&:has(:focus-visible)]:shadow-[0_8px_28px_-10px_color-mix(in_oklab,var(--aura)_55%,transparent)]',
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}
