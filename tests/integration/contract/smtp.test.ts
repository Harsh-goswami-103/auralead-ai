// T33 (R27, E7, ADR-41, ADR-100; fixture-tested against a local fake server, not live-verified):
// the SMTP transport through nodemailer's SMTPConnection.
// - A send: STARTTLS before AUTH (TLS required, the certificate checked against the configured
//   host), AUTH over TLS only, MAIL FROM / RCPT TO / DATA, the message carries the unsubscribe
//   headers, our Message-ID (the provider id), text/plain and the PDF; QUIT.
// - 4xx at any step is RETRYABLE, 5xx PERMANENT (a refused login PROVIDER_AUTH).
// - A timeout after the server accepted DATA is AMBIGUOUS; a timeout or refusal before is PRE_SEND.
// - A server without STARTTLS is refused before the password is sent; private addresses and
//   non-SMTP ports are refused before any socket; DEMO is refused before name resolution.
// - The connection test connects, upgrades, authenticates and quits: no MAIL FROM.
// Every socket goes to 127.0.0.1 (net.createServer): zero outbound connections.
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock } from '@/lib/clock';
import type { EmailSendRequest } from '@/server/adapters/email/port';
import { checkSmtpConnection, createSmtpTransport, type SmtpOptions } from '@/server/adapters/email/smtp';
import { outboundAttempts, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import { testIntegrationConnection } from '@/server/services/integrations/connection-test';
import { liveAdapters } from '@/server/services/integrations/live-adapters';
import { createLiveHarness, type LiveHarness } from '../integrations/live-support';
import { storeSmtp } from './email-live-support';
import { startFakeSmtp, type FakeSmtp, type FakeSmtpScript } from './smtp-support';

const clock = new FixedClock('2026-10-20T06:00:00.000Z');
const PASSWORD = 'smtp pass W0rd!';
const pdf = Buffer.from('%PDF-1.4\n% contract test quotation\n%%EOF\n');

const request = (over: Partial<EmailSendRequest> = {}): EmailSendRequest => ({
  attemptId: 'attsmtp0001',
  idempotencyKey: 'dispatch-attempt:msg_s:1',
  workspaceId: 'ws_contract',
  from: { name: 'Live Dental Co', address: 'quotes@live-dental-co.invalid' },
  to: 'lead@example.net',
  subject: 'Quotation Q-0007 from Live Dental Co',
  text: 'Hello Asha,\n\nPlease find attached quotation Q-0007.\n\n--\nTo stop emails from Live Dental Co, open https://app.example.test/unsubscribe/tok',
  headers: { 'List-Unsubscribe': '<https://app.example.test/api/unsubscribe?token=tok>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  attachments: [{ filename: 'Q-0007-v2.pdf', contentType: 'application/pdf', bytes: pdf, sha256: createHash('sha256').update(pdf).digest('hex') }],
  ...over,
});

let servers: FakeSmtp[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
  resetOutboundAttempts();
});

async function server(script: FakeSmtpScript = {}) {
  const s = await startFakeSmtp(script);
  servers.push(s);
  return s;
}

const options = (s: FakeSmtp, over: Partial<SmtpOptions> = {}): SmtpOptions => ({
  mode: 'live',
  host: 'smtp.example.test',
  port: 587,
  username: 'quotes',
  password: PASSWORD,
  fromAddress: 'quotes@example.com',
  clock,
  seams: s.seams(),
  ...over,
});

describe('a send', () => {
  it('upgrades with STARTTLS before AUTH, sends the message with the unsubscribe headers, our Message-ID and the PDF, then quits', async () => {
    const s = await server();
    const outcome = await createSmtpTransport(options(s)).send(request());
    expect(outcome).toEqual({ status: 'sent', providerMessageId: 'attsmtp0001@example.com', simulated: false });
    expect(s.commands.map((c) => c.split(/[ :]/)[0])).toEqual(['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
    expect(s.authOverTls).toEqual([true]);
    expect(s.passwordsSeen).toEqual([PASSWORD]);
    expect(s.commands).toContain('MAIL FROM:<quotes@example.com> SIZE=' + s.commands.find((c) => c.startsWith('MAIL'))!.split('SIZE=')[1]);
    expect(s.commands).toContain('RCPT TO:<lead@example.net>');
    const message = s.messages[0]!;
    expect(message).toMatch(/^From: Live Dental Co <quotes@example\.com>\r$/m);
    expect(message).toMatch(/^To: lead@example\.net\r$/m);
    expect(message).toMatch(/^Message-ID: <attsmtp0001@example\.com>\r$/m);
    expect(message).toMatch(/^List-Unsubscribe: <https:\/\/app\.example\.test\/api\/unsubscribe\?token=tok>\r$/m);
    expect(message).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click\r$/m);
    expect(message).toContain('Content-Type: text/plain');
    expect(message).toContain('Content-Type: application/pdf; name=Q-0007-v2.pdf');
    expect(message).toContain(pdf.toString('base64'));
    expect(message).not.toContain('text/html');
    expect(message).not.toMatch(/^Reply-To:/m);
    expect(message).not.toContain('.invalid');
  });

  it('a 4xx reply is RETRYABLE (at RCPT and after the message), a 5xx PERMANENT, a refused login PROVIDER_AUTH', async () => {
    expect(await createSmtpTransport(options(await server({ rcptTo: '450 4.2.1 Mailbox busy' }))).send(request())).toMatchObject({ status: 'failed', failureClass: 'RETRYABLE', reasonCode: 'SMTP_TRANSIENT' });
    expect(await createSmtpTransport(options(await server({ afterData: '451 4.3.0 Try again later' }))).send(request())).toMatchObject({ status: 'failed', failureClass: 'RETRYABLE', reasonCode: 'SMTP_TRANSIENT' });
    expect(await createSmtpTransport(options(await server({ rcptTo: '550 5.1.1 No such user' }))).send(request())).toMatchObject({ status: 'failed', failureClass: 'PERMANENT', reasonCode: 'SMTP_REJECTED' });
    expect(await createSmtpTransport(options(await server({ afterData: '554 5.7.1 Message rejected as spam' }))).send(request())).toMatchObject({ status: 'failed', failureClass: 'PERMANENT', reasonCode: 'SMTP_REJECTED' });
    const auth = await createSmtpTransport(options(await server({ auth: '535 5.7.8 Authentication credentials invalid' }))).send(request());
    expect(auth).toMatchObject({ status: 'failed', failureClass: 'PERMANENT', reasonCode: 'PROVIDER_AUTH' });
    expect(JSON.stringify(auth)).not.toContain(PASSWORD);
  });

  it('a timeout after the server accepted DATA is AMBIGUOUS (the message reached it; never resent blindly)', async () => {
    const s = await server({ afterData: 'silent' });
    expect(await createSmtpTransport(options(s)).send(request())).toMatchObject({ status: 'ambiguous', reasonCode: 'SMTP_TIMEOUT_AFTER_DATA' });
    expect(s.messages).toHaveLength(1);
  });

  it('a timeout before DATA (no greeting, no answer to RCPT or to DATA itself) is PRE_SEND: the body was never written', async () => {
    for (const script of [{ greeting: 'silent' }, { rcptTo: 'silent' }, { data: 'silent' }] as FakeSmtpScript[]) {
      const s = await server(script);
      expect(await createSmtpTransport(options(s)).send(request()), JSON.stringify(script)).toMatchObject({ status: 'failed', failureClass: 'PRE_SEND' });
      expect(s.messages).toHaveLength(0);
    }
  });

  it('a refused connection is PRE_SEND', async () => {
    const s = await server();
    const seams = s.seams();
    await s.close();
    servers = [];
    expect(await createSmtpTransport(options(s, { seams })).send(request())).toMatchObject({ status: 'failed', failureClass: 'PRE_SEND', reasonCode: 'CONNECT_FAILED' });
  });
});

describe('TLS and destination rules', () => {
  it('a server without STARTTLS is refused before AUTH: the password never crosses a plaintext connection', async () => {
    const s = await server({ starttls: false });
    expect(await createSmtpTransport(options(s)).send(request())).toMatchObject({ status: 'failed', failureClass: 'PRE_SEND', reasonCode: 'SMTP_TLS_FAILED' });
    expect(s.passwordsSeen).toEqual([]);
    expect(s.commands.some((c) => c.startsWith('AUTH') || c.startsWith('MAIL'))).toBe(false);
  });

  it('a certificate that does not match the configured host is refused (TLS verified), before AUTH', async () => {
    const s = await server();
    expect(await createSmtpTransport(options(s, { host: 'mail.other-host.test' })).send(request())).toMatchObject({ status: 'failed', failureClass: 'PRE_SEND', reasonCode: 'SMTP_TLS_FAILED' });
    expect(s.passwordsSeen).toEqual([]);
  });

  it('a host resolving to a private address, an IP literal or a non-SMTP port is refused before any socket (PERMANENT)', async () => {
    const lookup = async () => [{ address: '10.0.0.5', family: 4 }];
    expect(await createSmtpTransport(options(await server(), { seams: { lookup } })).send(request())).toMatchObject({ failureClass: 'PERMANENT', reasonCode: 'SMTP_HOST_BLOCKED' });
    const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
    expect(await createSmtpTransport(options(await server(), { seams: { lookup: mixed } })).send(request())).toMatchObject({ reasonCode: 'SMTP_HOST_BLOCKED' });
    expect(await createSmtpTransport(options(await server(), { seams: {}, host: '127.0.0.1' })).send(request())).toMatchObject({ reasonCode: 'SMTP_HOST_BLOCKED' });
    expect(await createSmtpTransport(options(await server(), { seams: { lookup }, port: 6379 })).send(request())).toMatchObject({ reasonCode: 'SMTP_HOST_BLOCKED' });
  });

  it('DEMO is stopped by the outbound tripwire before name resolution (PRE_SEND, recorded blocked)', async () => {
    let looked = false;
    const lookup = async () => {
      looked = true;
      return [{ address: '93.184.216.34', family: 4 }];
    };
    expect(await createSmtpTransport(options(await server(), { mode: 'demo', seams: { lookup } })).send(request())).toMatchObject({ status: 'failed', failureClass: 'PRE_SEND' });
    expect(looked).toBe(false);
    expect(outboundAttempts()).toEqual([expect.objectContaining({ host: 'smtp.example.test', mode: 'demo', blocked: true })]);
  });
});

describe('connection test', () => {
  it('connects, upgrades, authenticates and quits: no MAIL FROM, no message', async () => {
    const s = await server();
    expect(await checkSmtpConnection(options(s))).toEqual({ ok: true });
    expect(s.commands.map((c) => c.split(' ')[0])).toEqual(['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'QUIT']);
    expect(s.messages).toEqual([]);
  });

  it('classifies a refused login, a missing STARTTLS, a busy server and no answer', async () => {
    expect(await checkSmtpConnection(options(await server({ auth: '535 5.7.8 bad credentials' })))).toMatchObject({ ok: false, kind: 'auth' });
    expect(await checkSmtpConnection(options(await server({ starttls: false })))).toMatchObject({ ok: false, kind: 'tls' });
    expect(await checkSmtpConnection(options(await server({ greeting: '421 4.3.2 Service not available' })))).toMatchObject({ ok: false, kind: 'transient' });
    const failed = await checkSmtpConnection(options(await server({ greeting: 'silent' })));
    expect(failed).toMatchObject({ ok: false, kind: 'unreachable' });
    expect(JSON.stringify(failed)).not.toContain(PASSWORD);
  });
});

describe('the registered SMTP tester (LIVE, stored integration)', () => {
  let h: LiveHarness;
  beforeAll(async () => {
    h = await createLiveHarness('t33-smtp-tester');
  }, 120_000);
  afterAll(async () => h?.destroy());

  const run = async (s: FakeSmtp) => {
    Object.assign(h.smtpSeams, s.seams());
    return testIntegrationConnection(await h.owner(), { kind: 'EMAIL_SMTP' }, { testers: liveAdapters(h.deps()).testers });
  };

  it('CONNECTED only after a real login over TLS; a refused login is ERROR PROVIDER_AUTH; no STARTTLS is ERROR SMTP_TLS_FAILED', async () => {
    await storeSmtp(h, { status: 'CONFIGURED_UNVERIFIED' });
    expect(await run(await server())).toMatchObject({ outcome: 'TESTED', status: 'CONNECTED' });
    expect(await run(await server({ auth: '535 5.7.8 bad credentials' }))).toMatchObject({ status: 'ERROR', errorCode: 'PROVIDER_AUTH' });
    expect(await run(await server({ starttls: false }))).toMatchObject({ status: 'ERROR', errorCode: 'SMTP_TLS_FAILED' });
    await storeSmtp(h, { status: 'CONNECTED' });
    expect(await run(await server({ greeting: 'silent' }))).toMatchObject({ status: 'DEGRADED', errorCode: 'PROVIDER_UNREACHABLE' });
  });
});
