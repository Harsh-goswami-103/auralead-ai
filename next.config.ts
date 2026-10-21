import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import { ensureEnvLoaded } from './src/lib/env-load';

// The single env loader runs first (E12, ADR-44): real env vars win over .env.
ensureEnvLoaded();

// Pin the workspace root: a stray lockfile in a parent folder must not change resolution.
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

const publicQuoteHeaders = [
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Robots-Tag', value: 'noindex' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The E2E harness (tests/e2e/support, T09) builds the LIVE variant into a second dir so the
  // DEMO and LIVE bundles can be served side by side (ADR-50). Unset: the default .next.
  distDir: process.env.AURALEAD_NEXT_DIST_DIR || '.next',
  turbopack: { root: projectRoot },
  outputFileTracingRoot: projectRoot,
  // Native or heavy server modules are loaded with Node's require, never bundled (plan §2.3).
  serverExternalPackages: ['better-sqlite3', '@prisma/adapter-better-sqlite3', '@node-rs/argon2', 'sharp', '@react-pdf/renderer', 'google-auth-library'],
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // T16 (ADR-09): the public quote page and its API never leak the share token in a Referer and
      // are never indexed. Listed after the global rule, so these values win for the same keys.
      { source: '/quote/:path*', headers: publicQuoteHeaders },
      { source: '/api/quote-share/:path*', headers: publicQuoteHeaders },
    ];
  },
};

export default nextConfig;
