/**
 * The AuraLead mark (design spec §6 "Shell"): a flat inline SVG of a ring with three strokes for
 * the lead sources flowing into one core. The ring runs aura to volt-hi, and the core is an
 * ice-to-aura dot. The inbound strokes are zest and flare, kept on the aura side of the ring so
 * pink never sits next to blue. The outbound stroke is ice. The fills are flat gradients with no
 * glow and no motion. It is decorative, so it is hidden from assistive tech; the link or heading
 * around it carries the name. Gradient ids come from useId so several marks on one page never
 * collide. Server-safe. src/app/icon.svg is the same drawing in hex.
 */
import { useId } from 'react';

export function ProductMark({ className }: { className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const tile = `pm-tile-${uid}`;
  const ring = `pm-ring-${uid}`;
  const core = `pm-core-${uid}`;
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={className}>
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--bg-3)' }} />
          <stop offset="1" style={{ stopColor: 'var(--bg-1)' }} />
        </linearGradient>
        <linearGradient id={ring} x1="7" y1="16" x2="25" y2="16" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: 'var(--aura)' }} />
          <stop offset="1" style={{ stopColor: 'var(--volt-hi)' }} />
        </linearGradient>
        <radialGradient id={core}>
          <stop offset="0" style={{ stopColor: 'var(--ice)' }} />
          <stop offset="1" style={{ stopColor: 'var(--aura)' }} />
        </radialGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill={`url(#${tile})`} stroke="var(--border-strong)" />
      <circle cx="16" cy="16" r="8.5" fill="none" stroke={`url(#${ring})`} strokeWidth="2.25" />
      <circle cx="16" cy="16" r="3" fill={`url(#${core})`} />
      <path d="M5.75 9.25 11.4 12.9" stroke="var(--zest)" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M5.75 22.75l5.65-3.65" stroke="var(--flare)" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M26.25 16h-6.4" stroke="var(--ice)" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}
