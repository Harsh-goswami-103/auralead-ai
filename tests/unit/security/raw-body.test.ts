import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RAW_BODY_LIMITS, RawBodyError, readRawBody } from '@/server/security/raw-body';

type Source = { headers: Headers; body: ReadableStream<Uint8Array> | null; pulls: () => number; cancelled: () => boolean };

/** A body stream that yields the given chunks one pull at a time and records how far it was read. */
function source(chunks: Uint8Array[], headers: Record<string, string> = {}): Source {
  let pulls = 0;
  let cancelled = false;
  let i = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        const next = chunks[i++];
        if (next) controller.enqueue(next);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { headers: new Headers(headers), body, pulls: () => pulls, cancelled: () => cancelled };
}

async function rejection(p: Promise<unknown>): Promise<RawBodyError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(RawBodyError);
    return err as RawBodyError;
  }
  throw new Error('expected readRawBody to reject');
}

describe('readRawBody (A34, C14)', () => {
  it('rejects with 413 on a Content-Length over the cap before reading any byte', async () => {
    const src = source([new Uint8Array(10)], { 'content-length': '2000' });
    const err = await rejection(readRawBody(src, { maxBytes: 1000 }));
    expect(err.status).toBe(413);
    expect(err.code).toBe('PAYLOAD_TOO_LARGE');
    expect(src.pulls()).toBe(0);
  });

  it('rejects with 413 for a real Request whose Content-Length is over the cap, leaving the body unread', async () => {
    const req = new Request('http://localhost/api/webhooks/meta-ads', {
      method: 'POST',
      headers: { 'content-length': String(RAW_BODY_LIMITS.meta + 1) },
      body: 'x',
    });
    const err = await rejection(readRawBody(req, { maxBytes: RAW_BODY_LIMITS.meta }));
    expect(err.status).toBe(413);
    expect(req.bodyUsed).toBe(false);
  });

  it('aborts a chunked body (no Content-Length) as soon as the running count passes the cap', async () => {
    const chunk = new Uint8Array(400).fill(0x61);
    const src = source([chunk, chunk, chunk, chunk, chunk, chunk]);
    const err = await rejection(readRawBody(src, { maxBytes: 1000 }));
    expect(err.status).toBe(413);
    // 400 + 400 + 400 > 1000 after the third chunk; the rest is never pulled.
    expect(src.pulls()).toBe(3);
    expect(src.cancelled()).toBe(true);
  });

  it('aborts when the body is larger than a lying Content-Length under the cap', async () => {
    const src = source([new Uint8Array(600), new Uint8Array(600)], { 'content-length': '10' });
    const err = await rejection(readRawBody(src, { maxBytes: 1000 }));
    expect(err.status).toBe(413);
  });

  it('accepts a body exactly at the cap', async () => {
    const src = source([new Uint8Array(500), new Uint8Array(500)]);
    const buf = await readRawBody(src, { maxBytes: 1000 });
    expect(buf.length).toBe(1000);
  });

  it('rejects a malformed Content-Length with 400', async () => {
    for (const bad of ['abc', '-1', '1.5', '1e3']) {
      const err = await rejection(readRawBody(source([], { 'content-length': bad }), { maxBytes: 1000 }));
      expect(err.status).toBe(400);
      expect(err.code).toBe('BAD_CONTENT_LENGTH');
    }
  });

  it('returns an empty buffer for a missing body', async () => {
    const buf = await readRawBody({ headers: new Headers(), body: null }, { maxBytes: 10 });
    expect(buf.length).toBe(0);
  });

  it('preserves exact bytes, including \\u0930 escapes and multibyte UTF-8 split across chunks', async () => {
    // Meta sends non-ASCII as JSON escapes; the signature is over those exact bytes.
    const json = '{"entry":[{"name":"\\u0930\\u093e\\u091c","city":"दिल्ली","note":"a\\/b"}]}';
    const original = Buffer.from(json, 'utf8');
    // Split inside a multibyte character on purpose.
    const cut = original.indexOf(Buffer.from('दि', 'utf8')) + 1;
    const src = source([original.subarray(0, 7), original.subarray(7, cut), original.subarray(cut)], {
      'content-length': String(original.length),
    });
    const raw = await readRawBody(src, { maxBytes: RAW_BODY_LIMITS.meta });
    expect(raw.equals(original)).toBe(true);
    expect(raw.toString('utf8')).toContain('\\u0930\\u093e\\u091c');

    const secret = 'app-secret';
    const sig = (b: Buffer | string) => createHmac('sha256', secret).update(b).digest('hex');
    expect(sig(raw)).toBe(sig(original));
    // Re-serialized JSON is not the same bytes, so a signature over it would not verify.
    expect(sig(JSON.stringify(JSON.parse(raw.toString('utf8'))))).not.toBe(sig(original));
  });

  it('works with a real Request body', async () => {
    const body = '{"a":"\\u0930"}';
    const req = new Request('http://localhost/x', { method: 'POST', body });
    const raw = await readRawBody(req, { maxBytes: 1024 });
    expect(raw.toString('utf8')).toBe(body);
  });

  it('exposes the plan §9 limits', () => {
    expect(RAW_BODY_LIMITS).toEqual({
      meta: 1_048_576,
      whatsapp: 1_048_576,
      sheets: 262_144,
      extension: 1_048_576,
    });
  });
});
