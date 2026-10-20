/**
 * Initials avatar for people in the client panel (team members, leads in the inbox). The hue says
 * something real: the panel hue for workspace people, the channel's category color for a thread
 * (WhatsApp = chart-3 pink, Email = ice, from source-style). Initials are derived from the name
 * deterministically. Decorative (aria-hidden): the name is always printed next to it. Server-safe.
 */
import { cn } from '@/components/ui/cn';

export type AvatarTone = 'panel' | 'whatsapp' | 'email' | 'neutral';

const TONES: Readonly<Record<AvatarTone, string>> = {
  panel: 'bg-panel/14 text-panel ring-panel/30',
  whatsapp: 'bg-chart-3/16 text-chart-3-hi ring-chart-3-hi/35',
  email: 'bg-ice/10 text-ice ring-ice/30',
  neutral: 'bg-bg-3 text-fg-2 ring-border-strong',
};

export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return '?';
  const first = Array.from(words[0]!)[0] ?? '';
  const last = words.length > 1 ? (Array.from(words[words.length - 1]!)[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function InitialsAvatar(props: { name: string; tone?: AvatarTone; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const size = props.size ?? 'md';
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-display font-semibold tracking-wide ring-1 ring-inset select-none',
        size === 'sm' && 'size-7 text-[11px]',
        size === 'md' && 'size-9 text-xs',
        size === 'lg' && 'size-11 text-sm',
        TONES[props.tone ?? 'panel'],
        props.className,
      )}
    >
      {initialsOf(props.name)}
    </span>
  );
}
