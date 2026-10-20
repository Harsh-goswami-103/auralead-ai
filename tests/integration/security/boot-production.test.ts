/**
 * ADR-69: production boot checks for LIVE. The session cookie is `__Host-aura_session`, which
 * browsers only accept over HTTPS (or on localhost), so a LIVE deployment on a plain-HTTP public
 * hostname would boot and then nobody could sign in. Boot refuses that combination, and warns when
 * the insecure-cookie escape hatch is on in LIVE.
 */
import { describe, expect, it } from 'vitest';
import { BootError, bootFromEnv } from '@/server/boot';
import { testEnv } from '../auth/support';

/** A correctly deployed LIVE instance: HTTPS behind exactly one TLS-terminating proxy. */
const live = (extra: Record<string, string>) => bootFromEnv(testEnv('live', { TRUSTED_PROXY_HOPS: '1', ...extra }));

describe('LIVE origin and cookie checks', () => {
  it('accepts an HTTPS origin', () => {
    expect(live({ APP_ORIGIN: 'https://app.auralead.example' }).warnings).toEqual([]);
  });

  it('accepts plain HTTP on localhost, 127.0.0.1 and ::1 (browsers allow Secure cookies there)', () => {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(() => live({ APP_ORIGIN: origin })).not.toThrow();
    }
  });

  it('refuses a plain-HTTP public hostname, naming the fix', () => {
    const run = () => live({ APP_ORIGIN: 'http://app.auralead.example' });
    expect(run).toThrow(BootError);
    try {
      run();
    } catch (error) {
      expect((error as BootError).issues.join('\n')).toMatch(/APP_ORIGIN.*https/i);
    }
  });

  it('lets the documented dev flag through on a plain-HTTP host, with a warning', () => {
    const { warnings } = live({ APP_ORIGIN: 'http://devbox.internal:3000', AUTH_COOKIE_INSECURE_DEV: '1' });
    expect(warnings.join('\n')).toMatch(/AUTH_COOKIE_INSECURE_DEV/);
  });

  it('warns when the insecure-cookie flag is set behind HTTPS in LIVE', () => {
    const { warnings } = live({ APP_ORIGIN: 'https://app.auralead.example', AUTH_COOKIE_INSECURE_DEV: '1' });
    expect(warnings.join('\n')).toMatch(/AUTH_COOKIE_INSECURE_DEV/);
  });

  it('refuses an HTTPS origin with TRUSTED_PROXY_HOPS=0: behind a TLS proxy every client would share one rate-limit bucket', () => {
    const run = () => bootFromEnv(testEnv('live', { APP_ORIGIN: 'https://app.auralead.example', TRUSTED_PROXY_HOPS: '0' }));
    expect(run).toThrow(BootError);
    try {
      run();
    } catch (error) {
      expect((error as BootError).issues.join('\n')).toMatch(/TRUSTED_PROXY_HOPS/);
    }
  });

  it('does not require proxy hops on localhost (no proxy in front of a local LIVE run)', () => {
    expect(() => bootFromEnv(testEnv('live', { APP_ORIGIN: 'http://localhost:3000', TRUSTED_PROXY_HOPS: '0' }))).not.toThrow();
  });

  it('does not apply to DEMO', () => {
    expect(() => bootFromEnv(testEnv('demo', { APP_ORIGIN: 'http://app.auralead.example' }))).not.toThrow();
  });
});
