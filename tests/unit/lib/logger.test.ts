import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, withCorrelation } from '@/lib/logger';
import { REDACTED } from '@/lib/redact';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      cb();
    },
  });
  return { stream, records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>), raw: () => lines.join('\n') };
}

const SECRET = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

describe('logger', () => {
  it('writes structured JSON with the level and message', () => {
    const out = capture();
    const log = createLogger({ level: 'info', destination: out.stream });
    log.info({ jobId: 'job_1' }, 'claimed');
    log.debug('hidden at info level');
    const [rec, ...rest] = out.records();
    expect(rest).toEqual([]);
    expect(rec).toMatchObject({ level: 'info', msg: 'claimed', jobId: 'job_1' });
  });

  it('redacts secrets and PII in fields, nested objects and the message', () => {
    const out = capture();
    const log = createLogger({ level: 'info', destination: out.stream });
    log.info(
      { headers: { authorization: `Bearer ${SECRET}` }, lead: { phoneE164: '+919810012345', city: 'Pune' }, url: '/quote/Zm9vYmFyYmF6cXV4cXV1eA' },
      `sent to priya@example.com using ${SECRET}`,
    );
    const raw = out.raw();
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('+919810012345');
    expect(raw).not.toContain('priya@example.com');
    expect(raw).not.toContain('Zm9vYmFyYmF6cXV4cXV1eA');
    const rec = out.records()[0]!;
    expect((rec.lead as Record<string, unknown>).city).toBe('Pune');
    expect((rec.lead as Record<string, unknown>).phoneE164).toBe(REDACTED);
    expect(rec.msg).toBe(`sent to ${REDACTED} using ${REDACTED}`);
  });

  it('serializes errors without stacks', () => {
    const out = capture();
    const log = createLogger({ level: 'info', destination: out.stream });
    const err = new Error(`provider said ${SECRET}`);
    log.error({ err }, 'send failed');
    const rec = out.records()[0]!;
    expect(rec.err).toEqual({ name: 'Error', message: `provider said ${REDACTED}` });
    expect(out.raw()).not.toMatch(/\n\s+at |"stack"/);
  });

  it('withCorrelation binds the correlation id to every line', () => {
    const out = capture();
    const log = withCorrelation(createLogger({ level: 'info', destination: out.stream }), 'req_abc123def456');
    log.warn('one');
    log.info({ k: 1 }, 'two');
    expect(out.records().map((r) => r.correlationId)).toEqual(['req_abc123def456', 'req_abc123def456']);
  });
});
