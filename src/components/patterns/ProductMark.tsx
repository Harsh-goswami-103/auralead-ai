/**
 * The AuraLead mark: a flat inline SVG (ring plus three converging strokes for the lead sources
 * flowing into one core). No glow, no gradient; decorative, so hidden from assistive tech.
 */
export function ProductMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={className}>
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="var(--bg-2)" stroke="var(--border-strong)" />
      <circle cx="16" cy="16" r="8.5" fill="none" stroke="var(--accent)" strokeWidth="2" />
      <circle cx="16" cy="16" r="2.75" fill="var(--accent)" />
      <path d="M6 9.5 11.5 13M6 22.5l5.5-3.5M26 16h-6.25" stroke="var(--text-2)" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}
