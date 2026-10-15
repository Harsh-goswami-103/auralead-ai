import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '@/lib/config';

const LOCAL = 'C:\\Users\\Asus\\AppData\\Local';
const pathOpts = { platform: 'win32' as const, cwd: 'C:\\work', homedir: 'C:\\Users\\Asus' };

const secret = () => randomBytes(32).toString('base64url');
const key32 = () => randomBytes(32).toString('base64');

function liveSecrets() {
  return {
    SESSION_SECRET: secret(),
    SHARE_NONCE_KEY: secret(),
    SUPPRESSION_PEPPER: secret(),
    CREDENTIALS_KEYRING: JSON.stringify({ k1: key32(), k2: key32() }),
    CREDENTIALS_ACTIVE_KID: 'k2',
  };
}

function issues(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).issues;
  }
  throw new Error('expected ConfigError');
}

describe('parseConfig: demo defaults', () => {
  it('an empty environment is a valid DEMO config', () => {
    const c = parseConfig({ LOCALAPPDATA: LOCAL }, pathOpts);

    expect(c.mode).toBe('demo');
    expect(c.publicMode).toBe('demo');
    expect(c.appOrigin).toBe('http://localhost:3000');
    expect(c.logLevel).toBe('info');
    expect(c.outboundPaused).toBe(false);
    expect(c.testControl).toEqual({ enabled: false, token: null });
    expect(c.trustedProxyHops).toBe(0);
    expect(c.authCookieInsecureDev).toBe(false);
    expect(c.seedNow).toBeNull();
    expect(c.paths.dbFile).toBe(`${LOCAL}\\auralead\\demo\\app.db`);
    expect(c.secrets.sessionSecret).toBeNull();
  });

  it('parses provided demo secrets and the key ring', () => {
    const s = liveSecrets();
    const c = parseConfig({ LOCALAPPDATA: LOCAL, ...s }, pathOpts);

    expect(c.secrets.sessionSecret).toBe(s.SESSION_SECRET);
    expect(c.secrets.credentials?.activeKid).toBe('k2');
    expect(Object.keys(c.secrets.credentials?.keys ?? {}).sort()).toEqual(['k1', 'k2']);
    expect(c.secrets.credentials?.keys.k1?.length).toBe(32);
  });

  it('parses booleans, numbers and SEED_NOW', () => {
    const c = parseConfig(
      {
        OUTBOUND_PAUSED: '1',
        TRUSTED_PROXY_HOPS: '2',
        AUTH_COOKIE_INSECURE_DEV: 'true',
        SEED_NOW: '2026-10-01T06:30:00Z',
        LOG_LEVEL: 'debug',
        AURALEAD_TEST_CONTROL: '1',
        TEST_CONTROL_TOKEN: secret(),
      },
      pathOpts,
    );

    expect(c.outboundPaused).toBe(true);
    expect(c.trustedProxyHops).toBe(2);
    expect(c.authCookieInsecureDev).toBe(true);
    expect(c.seedNow?.toISOString()).toBe('2026-10-01T06:30:00.000Z');
    expect(c.logLevel).toBe('debug');
    expect(c.testControl.enabled).toBe(true);
  });

  it('rejects invalid values with readable issues', () => {
    const found = issues(() =>
      parseConfig(
        { APP_MODE: 'staging', LOG_LEVEL: 'loud', TRUSTED_PROXY_HOPS: '-1', OUTBOUND_PAUSED: 'maybe', APP_ORIGIN: 'not a url' },
        pathOpts,
      ),
    );

    expect(found.join('\n')).toMatch(/APP_MODE/);
    expect(found.join('\n')).toMatch(/LOG_LEVEL/);
    expect(found.join('\n')).toMatch(/TRUSTED_PROXY_HOPS/);
    expect(found.join('\n')).toMatch(/OUTBOUND_PAUSED/);
    expect(found.join('\n')).toMatch(/APP_ORIGIN/);
  });

  it('test control needs a strong token', () => {
    expect(issues(() => parseConfig({ AURALEAD_TEST_CONTROL: '1' }, pathOpts)).join('\n')).toMatch(/TEST_CONTROL_TOKEN/);
    expect(issues(() => parseConfig({ AURALEAD_TEST_CONTROL: '1', TEST_CONTROL_TOKEN: 'short' }, pathOpts)).join('\n')).toMatch(
      /TEST_CONTROL_TOKEN/,
    );
  });

  it('NEXT_PUBLIC_APP_MODE must match APP_MODE when set', () => {
    expect(issues(() => parseConfig({ APP_MODE: 'demo', NEXT_PUBLIC_APP_MODE: 'live' }, pathOpts)).join('\n')).toMatch(
      /NEXT_PUBLIC_APP_MODE/,
    );
  });

  it('rejects a malformed key ring even in DEMO', () => {
    expect(issues(() => parseConfig({ CREDENTIALS_KEYRING: 'not json' }, pathOpts)).join('\n')).toMatch(/CREDENTIALS_KEYRING/);
    expect(
      issues(() => parseConfig({ CREDENTIALS_KEYRING: JSON.stringify({ k1: 'c2hvcnQ=' }), CREDENTIALS_ACTIVE_KID: 'k1' }, pathOpts)).join(
        '\n',
      ),
    ).toMatch(/32 bytes/);
    expect(
      issues(() => parseConfig({ CREDENTIALS_KEYRING: JSON.stringify({ k1: key32() }), CREDENTIALS_ACTIVE_KID: 'k9' }, pathOpts)).join('\n'),
    ).toMatch(/CREDENTIALS_ACTIVE_KID/);
  });
});

describe('parseConfig: LIVE requires keys', () => {
  it('accepts a complete LIVE config', () => {
    const c = parseConfig({ APP_MODE: 'live', LOCALAPPDATA: LOCAL, ...liveSecrets() }, pathOpts);

    expect(c.mode).toBe('live');
    expect(c.paths.dbFile).toBe(`${LOCAL}\\auralead\\live\\app.db`);
    expect(c.secrets.suppressionPepper).toBeTruthy();
  });

  it.each(['SESSION_SECRET', 'SHARE_NONCE_KEY', 'SUPPRESSION_PEPPER', 'CREDENTIALS_KEYRING', 'CREDENTIALS_ACTIVE_KID'])(
    'refuses LIVE without %s',
    (missing) => {
      const env: Record<string, string> = { APP_MODE: 'live', ...liveSecrets() };
      delete env[missing];

      expect(issues(() => parseConfig(env, pathOpts)).join('\n')).toContain(missing);
    },
  );

  it('refuses LIVE with short secrets', () => {
    expect(issues(() => parseConfig({ APP_MODE: 'live', ...liveSecrets(), SESSION_SECRET: 'abc' }, pathOpts)).join('\n')).toMatch(
      /SESSION_SECRET/,
    );
  });

  it('refuses LIVE with AURALEAD_TEST_CONTROL=1', () => {
    const env = { APP_MODE: 'live', ...liveSecrets(), AURALEAD_TEST_CONTROL: '1', TEST_CONTROL_TOKEN: secret() };

    expect(issues(() => parseConfig(env, pathOpts)).join('\n')).toMatch(/AURALEAD_TEST_CONTROL/);
  });

  it('error messages never echo secret values', () => {
    const env = { APP_MODE: 'live', ...liveSecrets(), SUPPRESSION_PEPPER: 'tiny-pepper-value' };

    const text = issues(() => parseConfig(env, pathOpts)).join('\n');
    expect(text).not.toContain('tiny-pepper-value');
  });
});
