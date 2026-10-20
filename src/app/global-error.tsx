'use client';

/**
 * Last-resort error page (Next 16.4 global-error.js): it replaces the root layout when the layout
 * itself fails, so globals.css, the fonts and the Providers are all absent. Everything it needs is
 * here: its own <html>/<body>, inline styles with the Aurora hex values (no CSS variables exist
 * at this point), the system font stack (no web fonts), and a constant stylesheet with no markup
 * characters for focus and hover. It shows the digest as the Reference and never error.message.
 * "Try again" calls retry().
 */
import type { CSSProperties } from 'react';

const C = {
  bg0: '#060a13',
  bg1: '#0c111c',
  bg2: '#131927',
  border: 'rgba(213, 220, 240, 0.18)',
  text1: '#f1f3f9',
  text2: '#b7becc',
  aura: '#00e1f3',
  azure: '#1fc0ff',
  voltHi: '#5c94ff',
  zest: '#aff03c',
  flare: '#ff47c3',
  ice: '#d1f6fd',
  ink: '#00151c',
  danger: '#f75e51',
};

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/*
 * Focus and hover only. No angle brackets or ampersands, so the text is the same in every render
 * path. The secondary hover needs !important: the resting background is an inline style, which
 * outranks any stylesheet rule without it.
 */
const SHEET =
  '.ge-action:focus-visible{outline:2px solid #00e1f3;outline-offset:2px}.ge-primary:hover{filter:brightness(1.1)}.ge-secondary:hover{background:#1c2333!important}@media (prefers-reduced-motion: no-preference){.ge-action{transition:filter 150ms,background-color 150ms}}';

const styles: Record<string, CSSProperties> = {
  body: {
    margin: 0,
    minHeight: '100dvh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    boxSizing: 'border-box',
    color: C.text1,
    fontFamily: FONT,
    fontSize: 14,
    lineHeight: '20px',
    background: `radial-gradient(60% 50% at 85% 0%, rgba(0, 225, 243, 0.16), transparent 70%), radial-gradient(50% 45% at 0% 100%, rgba(175, 240, 60, 0.12), transparent 70%), ${C.bg0}`,
  },
  card: {
    width: '100%',
    maxWidth: 480,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    padding: 28,
    borderRadius: 16,
    border: `1px solid ${C.border}`,
    background: 'rgba(12, 17, 28, 0.86)',
    boxShadow: '0 16px 48px -12px rgba(0, 0, 0, 0.6)',
    position: 'relative',
    overflow: 'hidden',
  },
  hairline: {
    position: 'absolute',
    insetInline: 0,
    top: 0,
    height: 2,
    background: `linear-gradient(90deg, transparent, ${C.aura} 30%, ${C.voltHi} 70%, transparent)`,
  },
  brand: { display: 'flex', alignItems: 'center', gap: 10, fontWeight: 600, fontSize: 16 },
  h1: {
    margin: 0,
    fontSize: 26,
    lineHeight: '32px',
    fontWeight: 650,
    letterSpacing: '-0.01em',
    color: C.text1,
  },
  text: { margin: 0, color: C.text2 },
  reference: { margin: 0, color: C.text2, fontSize: 12, lineHeight: '16px' },
  code: {
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    color: C.text1,
    background: C.bg2,
    border: `1px solid ${C.border}`,
    borderRadius: 4,
    padding: '2px 6px',
    wordBreak: 'break-all',
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  primary: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    padding: '0 18px',
    border: 0,
    borderRadius: 8,
    background: `linear-gradient(135deg, ${C.aura}, ${C.azure})`,
    color: C.ink,
    font: `600 14px/20px ${FONT}`,
    cursor: 'pointer',
  },
  secondary: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    padding: '0 18px',
    borderRadius: 8,
    border: `1px solid ${C.border}`,
    background: C.bg2,
    color: C.text1,
    font: `500 14px/20px ${FONT}`,
    textDecoration: 'none',
  },
};

function Mark() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="ge-ring" x1="7" y1="16" x2="25" y2="16" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={C.aura} />
          <stop offset="1" stopColor={C.voltHi} />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill={C.bg2} stroke={C.border} />
      <circle cx="16" cy="16" r="8.5" fill="none" stroke="url(#ge-ring)" strokeWidth="2.25" />
      <circle cx="16" cy="16" r="3" fill={C.aura} />
      <path d="M5.75 9.25 11.4 12.9" stroke={C.zest} strokeWidth="1.9" strokeLinecap="round" />
      <path d="M5.75 22.75l5.65-3.65" stroke={C.flare} strokeWidth="1.9" strokeLinecap="round" />
      <path d="M26.25 16h-6.4" stroke={C.ice} strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en-IN" style={{ colorScheme: 'dark', background: C.bg0 }}>
      <body style={styles.body}>
        <title>Something went wrong | AuraLead AI</title>
        <style>{SHEET}</style>
        <main id="main" style={styles.card}>
          <span aria-hidden="true" style={styles.hairline} />
          <div style={styles.brand}>
            <Mark />
            AuraLead AI
          </div>
          <h1 style={styles.h1}>Something went wrong</h1>
          <p style={styles.text}>The app could not load. Try again; if it keeps failing, quote the reference when you contact support.</p>
          <p style={styles.reference}>
            Reference: <code style={styles.code}>{error.digest ?? 'not available'}</code>
          </p>
          <div style={styles.actions}>
            <button type="button" className="ge-action ge-primary" style={styles.primary} onClick={() => retry()}>
              Try again
            </button>
            <a href="/login" className="ge-action ge-secondary" style={styles.secondary}>
              Go to sign in
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
