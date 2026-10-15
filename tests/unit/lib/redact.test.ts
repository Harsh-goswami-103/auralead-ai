import { describe, expect, it } from 'vitest';
import { REDACTED, redact, redactText } from '@/lib/redact';

/** Secret shapes from plan §9 (bundle grep list) and the providers the app talks to. */
const SECRET_SAMPLES: Array<[string, string]> = [
  ['Anthropic key', 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdEFGH'],
  ['OpenAI key', 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd'],
  ['OpenAI legacy key', 'sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd'],
  ['Resend key', 're_AbCdEfGh_1234567890abcdefghij'],
  ['Meta access token', 'EAAGm0PX4ZCpsBAKZCZAbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
  ['extension token', 'alx_k7Hq2mZp_Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eA'],
  ['Google API key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv'],
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ['credential ciphertext', 'v1.k2026.bm9uY2Vub25jZQ.Y2lwaGVydGV4dA.dGFndGFndGFn'],
  ['HMAC signature header', 'sha256=3f1a2b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708'],
  ['Svix signature', 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='],
];

const PII_SAMPLES: Array<[string, string]> = [
  ['email', 'priya.sharma+leads@example.co.in'],
  ['E.164 phone', '+919810012345'],
  ['spaced Indian mobile', '98100 12345'],
  ['landline with dashes', '011-2345-6789'],
  ['IPv4 address', '203.0.113.42'],
];

describe('redactText: secret shapes', () => {
  it.each(SECRET_SAMPLES)('removes %s', (_label, secret) => {
    const out = redactText(`prefix ${secret} suffix`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
    expect(out.startsWith('prefix ')).toBe(true);
    expect(out.endsWith(' suffix')).toBe(true);
  });

  it('removes bearer and basic authorization values', () => {
    expect(redactText('Authorization: Bearer abc.def-ghi_123')).not.toContain('abc.def-ghi_123');
    expect(redactText('authorization: Basic dXNlcjpwYXNz')).not.toContain('dXNlcjpwYXNz');
  });

  it('removes PEM private keys', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    expect(redactText(`key: ${pem}`)).toBe(`key: ${REDACTED}`);
  });

  it('removes token-bearing URL segments and query parameters', () => {
    const out = redactText(
      'GET https://app.example.com/quote/Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eA?access_token=EAAB123&utm=x /unsubscribe/abcDEF123456789xyzABC /invite/tok_9a8b7c6d5e4f3a2b1c',
    );
    expect(out).toContain('/quote/' + REDACTED);
    expect(out).toContain('/unsubscribe/' + REDACTED);
    expect(out).toContain('/invite/' + REDACTED);
    expect(out).toContain('access_token=' + REDACTED);
    expect(out).toContain('utm=x');
    expect(out).not.toContain('Zm9vYmFy');
    expect(out).not.toContain('EAAB123');
  });

  it('removes key=value secrets in free text', () => {
    const out = redactText('password=hunter2 api_key: abcdef123456 secret="s3cr3t value"');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('abcdef123456');
    expect(out).not.toContain('s3cr3t');
  });
});

describe('redactText: PII patterns', () => {
  it.each(PII_SAMPLES)('removes %s', (_label, pii) => {
    const out = redactText(`contact ${pii} today`);
    expect(out).not.toContain(pii);
    expect(out).toBe(`contact ${REDACTED} today`);
  });

  it('keeps ordinary text, ISO timestamps, short numbers, amounts and ids', () => {
    const text = 'Quote Q-0007 v3 total 2124000 paise at 2026-10-15T10:00:00.000Z for lead clx9a8b7c6d5e4f3 (12 items)';
    expect(redactText(text)).toBe(text);
  });
});

describe('redact: structured values', () => {
  it('redacts sensitive keys whatever their value', () => {
    const out = redact({
      password: 'x',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$abc$def',
      accessToken: 'opaque',
      access_token: 'opaque',
      apiKey: 'k',
      'x-api-key': 'k',
      authorization: 'Bearer z',
      cookie: '__Host-aura_session=abc',
      'set-cookie': ['a=b'],
      clientSecret: 'cs',
      private_key: 'pk',
      signature: 'sig',
      tokenHash: 'deadbeef',
      secrets: { a: 1 },
      keep: 'value',
    });
    expect(out).toEqual({
      password: REDACTED,
      passwordHash: REDACTED,
      accessToken: REDACTED,
      access_token: REDACTED,
      apiKey: REDACTED,
      'x-api-key': REDACTED,
      authorization: REDACTED,
      cookie: REDACTED,
      'set-cookie': REDACTED,
      clientSecret: REDACTED,
      private_key: REDACTED,
      signature: REDACTED,
      tokenHash: REDACTED,
      secrets: REDACTED,
      keep: 'value',
    });
  });

  it('redacts PII keys (phone, email, address, wa_id, contactPlain, ip)', () => {
    const out = redact({
      phone: '12',
      phoneE164: '+919810012345',
      phoneRaw: 'x',
      mobile: '1',
      email: 'a',
      emailNormalized: 'b',
      wa_id: '919810012345',
      contactPlain: 'c',
      address: '12 MG Road',
      ipAddress: '1.2.3.4',
      ip: '1.2.3.4',
      city: 'Mumbai',
      displayName: 'Sharma Interiors',
    });
    expect(out).toEqual({
      phone: REDACTED,
      phoneE164: REDACTED,
      phoneRaw: REDACTED,
      mobile: REDACTED,
      email: REDACTED,
      emailNormalized: REDACTED,
      wa_id: REDACTED,
      contactPlain: REDACTED,
      address: REDACTED,
      ipAddress: REDACTED,
      ip: REDACTED,
      city: 'Mumbai',
      displayName: 'Sharma Interiors',
    });
  });

  it('applies text patterns to nested strings in objects and arrays (Meta and WhatsApp payload shapes)', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: '919810012345', text: { body: 'my email is priya@example.com, call +91 98100 12345' } }],
                metadata: { phone_number_id: '106540352242922' },
              },
            },
          ],
        },
      ],
      note: `token ${SECRET_SAMPLES[0]![1]}`,
    };
    const json = JSON.stringify(redact(payload));
    expect(json).not.toContain('priya@example.com');
    expect(json).not.toContain('98100 12345');
    expect(json).not.toContain('919810012345');
    expect(json).not.toContain(SECRET_SAMPLES[0]![1]);
  });

  it('does not mutate the input and preserves non-string scalars', () => {
    const input = { n: 5, b: true, nil: null, big: 2_124_000n, when: new Date('2026-10-15T10:00:00Z'), email: 'a@b.co' };
    const out = redact(input);
    expect(input.email).toBe('a@b.co');
    expect(out).toEqual({ n: 5, b: true, nil: null, big: 2_124_000n, when: new Date('2026-10-15T10:00:00Z'), email: REDACTED });
  });

  it('turns errors into name and redacted message without the stack', () => {
    const err = new Error('failed for priya@example.com with sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv');
    const out = redact({ err }) as { err: Record<string, unknown> };
    expect(out.err).toEqual({ name: 'Error', message: `failed for ${REDACTED} with ${REDACTED}` });
  });

  it('handles cycles and depth without throwing', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(redact(a)).toEqual({ name: 'a', self: '[Circular]' });
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 40; i += 1) deep = { child: deep };
    expect(JSON.stringify(redact(deep))).toContain('[Truncated]');
  });

  it('redacts a bare string', () => {
    expect(redact('mail priya@example.com')).toBe(`mail ${REDACTED}`);
  });
});
