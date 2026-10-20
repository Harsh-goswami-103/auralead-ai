/**
 * Runs in the browser before any application code (Next `instrumentation-client`, ADR-69).
 * Zod 4 builds parsers with `new Function` when it may. The nonce CSP forbids that (no
 * `unsafe-eval`), and the probe would raise a `securitypolicyviolation` on every page that loads
 * a schema even though Zod falls back to interpreted parsing. Telling Zod up front, before the
 * first schema is constructed, keeps the console clean and the policy strict. Server code is
 * unaffected and keeps the faster JIT parsers.
 */
import { config } from 'zod/v4/core';

config({ jitless: true });
