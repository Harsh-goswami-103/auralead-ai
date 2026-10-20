/**
 * The landing's in-page sections, in page order: the nav, its scroll-spy and the footer link to
 * these ids. Plain data, so the client nav island does not pull server-only modules along.
 */
export const LANDING_SECTIONS = [
  { href: '#how-it-works', label: 'How it works' },
  { href: '#features', label: 'Features' },
  { href: '#roi', label: 'ROI estimate' },
  { href: '#principles', label: 'Principles' },
] as const;

export type LandingSectionHref = (typeof LANDING_SECTIONS)[number]['href'];
