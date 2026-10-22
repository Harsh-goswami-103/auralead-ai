/**
 * SMTP email adapter (T33; plan §4.4, §6.3, §7, §9, ADR-41, ADR-100). LIVE only: built by
 * `adapters/registry.ts` from a workspace's connected EMAIL_SMTP integration (host, port,
 * username and from address in the config, the password as an encrypted credential).
 *
 * Built on nodemailer's low-level `SMTPConnection` (connect, login, send, quit) and its MIME
 * composer, so the transport knows exactly how far a send got:
 *  - before the server accepted DATA (354) the message body has not been written: a timeout, a
 *    reset or a refused connection there is PRE_SEND (definitely not sent);
 *  - once the body is being written (nodemailer reads the message stream only after the envelope,
 *    including DATA, was accepted), a timeout or reset is AMBIGUOUS (the server may have queued
 *    it; never resent blindly);
 *  - a 4xx reply at any step is RETRYABLE, a 5xx reply PERMANENT (a rejected login is
 *    PROVIDER_AUTH), through the dated error map.
 * TLS is required: implicit TLS on port 465, STARTTLS on every other port (`requireTLS`), TLS 1.2
 * or newer, certificates verified against the configured host name. A server without STARTTLS is
 * refused before AUTH, so the password never crosses a plaintext connection. The configured host
 * must resolve to public unicast addresses only (the socket is pinned to the checked address, SNI
 * and certificate checks keep the host name), and only the SMTP ports 25, 465, 587 and 2525 are
 * accepted: a workspace setting cannot reach the private network.
 *
 * DEMO never builds this transport; if one is built anyway, `guardOutboundSocket` refuses before
 * any name resolution or socket. The password is never logged (nodemailer's logger is off) and is
 * scrubbed from every error. SMTP has no delivery statuses and no inbound here: bounces are not
 * tracked and replies go to the from mailbox (disclosed on the setup page).
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import type { ConnectionOptions } from 'node:tls';
import MailComposer from 'nodemailer/lib/mail-composer';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import type { Clock } from '@/lib/clock';
import { OutboundBlockedInDemoError } from '@/lib/errors';
import { isPublicAddress, type LookupAll } from '@/server/security/safe-fetch';
import { guardOutboundSocket, type OutboundMode } from '../http/outbound';
import { boundedError } from '../whatsapp/error-map';
import { classifyEmailFailure } from './error-map';
import type { EmailSendRequest, EmailTransport, FailedOutcome, SendOutcome } from './port';

export const SMTP_CHECKED_ON = '2026-10-20';
/** The ports a workspace may configure (submission 587, implicit TLS 465, relay 25, alternate 2525). */
export const SMTP_PORTS: readonly number[] = [25, 465, 587, 2525];
const DEFAULT_TIMEOUTS = { connection: 10_000, greeting: 10_000, socket: 30_000 } as const;
const EMAIL_RE = /^[^\s@<>",;]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,76}$/;
const CRLF_RE = /[\r\n\u0000]/;
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

export type SmtpSettings = { host: string; port: number; username: string; password: string; fromAddress: string };

export type SmtpSeams = {
  /** Test seam: where the socket actually goes (a local fake server). Skips the public-address check. */
  connectTo?: { host: string; port: number };
  /** Test seam: extra TLS options (the test CA of the local server). */
  tls?: ConnectionOptions;
  /** Test seam: name resolution. */
  lookup?: LookupAll;
  timeoutsMs?: Partial<Record<keyof typeof DEFAULT_TIMEOUTS, number>>;
};

export type SmtpOptions = SmtpSettings & { mode: OutboundMode; clock: Clock; seams?: SmtpSeams };

type SmtpError = Error & { code?: string; responseCode?: number; command?: string };

/** How far a session got: the body counts as written once nodemailer starts reading it. */
type Phase = 'connect' | 'auth' | 'envelope' | 'data';

class BlockedHostError extends Error {
  readonly code = 'SMTP_HOST_BLOCKED';
}

const defaultLookup: LookupAll = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));

function scrubber(secrets: readonly string[]): (text: string) => string {
  return (text) => secrets.filter((s) => s.length > 0).reduce((t, s) => t.split(s).join('[REDACTED]'), text);
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/** The address to connect to: a test target, or the first resolved address once every one is public. */
async function resolveTarget(opts: SmtpOptions): Promise<{ host: string; port: number }> {
  if (opts.seams?.connectTo) return opts.seams.connectTo;
  if (!SMTP_PORTS.includes(opts.port)) throw new BlockedHostError(`port ${opts.port} is not an SMTP port`);
  if (isIP(opts.host)) throw new BlockedHostError('the SMTP host must be a name, not an address');
  const addresses = await (opts.seams?.lookup ?? defaultLookup)(opts.host);
  if (addresses.length === 0) throw Object.assign(new Error('the SMTP host has no address'), { code: 'ENOTFOUND' });
  if (!addresses.every((a) => isPublicAddress(a.address))) throw new BlockedHostError('the SMTP host resolves to a private or reserved address');
  return { host: addresses[0]!.address, port: opts.port };
}

async function openConnection(opts: SmtpOptions): Promise<SMTPConnection> {
  // Recorded, and refused in DEMO, before any name resolution or socket.
  guardOutboundSocket(opts.mode, opts.host, opts.clock.now());
  const target = await resolveTarget(opts);
  const t = { ...DEFAULT_TIMEOUTS, ...opts.seams?.timeoutsMs };
  const implicitTls = opts.port === 465;
  const connection = new SMTPConnection({
    host: target.host,
    port: target.port,
    servername: opts.host,
    secure: implicitTls,
    requireTLS: !implicitTls,
    name: domainOf(opts.fromAddress),
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: opts.host, ...opts.seams?.tls },
    connectionTimeout: t.connection,
    greetingTimeout: t.greeting,
    socketTimeout: t.socket,
    logger: false,
    debug: false,
    transactionLog: false,
  });
  // An 'error' event without a listener would throw; failures are read through each step instead.
  connection.on('error', () => undefined);
  return connection;
}

/** One callback step of the session as a promise; an error event or a closed connection rejects it. */
function step<T>(connection: SMTPConnection, run: (done: (err?: Error | null, value?: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      connection.removeListener('error', onError);
      connection.removeListener('end', onEnd);
      if (err) reject(err);
      else resolve(value as T);
    };
    const onError = (err: Error) => finish(err);
    const onEnd = () => finish(Object.assign(new Error('the connection closed unexpectedly'), { code: 'ECONNECTION' }));
    connection.once('error', onError);
    connection.once('end', onEnd);
    run((err, value) => finish(err ?? null, value));
  });
}

function connectStep(connection: SMTPConnection): Promise<void> {
  return step<void>(connection, (done) => connection.connect((err) => done(err ?? null)));
}

function loginStep(connection: SMTPConnection, opts: SmtpSettings): Promise<void> {
  return step<void>(connection, (done) => connection.login({ user: opts.username, pass: opts.password }, (err) => done(err ?? null)));
}

/** QUIT and wait until the session ended (the socket timeout bounds a server that never answers). */
function quit(connection: SMTPConnection): Promise<void> {
  return new Promise<void>((resolve) => {
    connection.once('end', () => resolve());
    try {
      connection.quit();
    } catch {
      connection.close();
    }
  });
}

function closeQuietly(connection: SMTPConnection | null, quit: boolean): void {
  if (!connection) return;
  try {
    if (quit) connection.quit();
    else connection.close();
  } catch {
    connection.close();
  }
}

function localFailure(reasonCode: string, error: string): FailedOutcome {
  return { status: 'failed', failureClass: 'PERMANENT', reasonCode, error: boundedError(error), suppress: false, manualRetryAfterMs: null, throttleScope: null };
}

function describe(error: SmtpError, scrub: (t: string) => string): string {
  const parts = [error.code ?? error.name, error.command ? `during ${error.command}` : null, error.message ? scrub(error.message) : null].filter(Boolean);
  return parts.join(' ');
}

/** A failed session step as a send outcome, from the reply code and how far the session got. */
function sendFailure(error: unknown, phase: Phase, scrub: (t: string) => string): SendOutcome {
  if (error instanceof OutboundBlockedInDemoError) return classifyEmailFailure({ transport: 'smtp', phase: 'before-write', message: 'outbound connection blocked in DEMO' });
  if (error instanceof BlockedHostError) return localFailure('SMTP_HOST_BLOCKED', error.message);
  const e = (error instanceof Error ? error : new Error(String(error))) as SmtpError;
  const message = describe(e, scrub);
  if (typeof e.responseCode === 'number' && e.responseCode >= 400 && e.responseCode < 600) {
    const classified = classifyEmailFailure({ transport: 'smtp', phase: 'response', smtpCode: e.responseCode, message });
    if (classified.status === 'failed' && e.code === 'EAUTH' && classified.failureClass === 'PERMANENT') return { ...classified, reasonCode: 'PROVIDER_AUTH' };
    if (classified.status === 'failed' && e.code === 'ETLS') return { ...classified, failureClass: 'PRE_SEND', reasonCode: 'SMTP_TLS_FAILED' };
    return classified;
  }
  if (phase === 'data') return { status: 'ambiguous', reasonCode: 'SMTP_TIMEOUT_AFTER_DATA', error: boundedError(message) };
  const before = classifyEmailFailure({ transport: 'smtp', phase: 'before-write', message });
  if (before.status === 'failed' && (e.code === 'ETLS' || /certificate|tls|ssl/i.test(e.message))) return { ...before, reasonCode: 'SMTP_TLS_FAILED' };
  return before;
}

/** The RFC 5322 message for one send: text/plain, the unsubscribe headers, the PDF, our own Message-ID. */
async function composeMessage(req: EmailSendRequest, opts: SmtpOptions, messageId: string): Promise<Buffer> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) headers[name] = value;
  const composer = new MailComposer({
    from: { name: req.from.name.replace(/[\u0000-\u001f\u007f"\\<>]/g, ' ').trim().slice(0, 100), address: opts.fromAddress },
    to: req.to,
    subject: req.subject.trim(),
    text: req.text,
    messageId: `<${messageId}>`,
    date: opts.clock.now(),
    headers,
    attachments: req.attachments.map((a) => ({ filename: a.filename.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 200), content: a.bytes, contentType: a.contentType })),
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return composer.compile().build();
}

export function createSmtpTransport(opts: SmtpOptions): EmailTransport {
  const scrub = scrubber([opts.password]);
  return {
    label: 'smtp',
    simulated: false,
    async send(req: EmailSendRequest): Promise<SendOutcome> {
      if (!EMAIL_RE.test(opts.fromAddress)) return localFailure('EMAIL_FROM_INVALID', 'the configured from address is not an email address');
      if (!EMAIL_RE.test(req.to)) return localFailure('INVALID_RECIPIENT', 'the recipient is not an email address');
      if (req.subject.trim() === '' || CRLF_RE.test(req.subject)) return localFailure('EMAIL_SUBJECT_INVALID', 'the subject is empty or has line breaks');
      if (req.text.trim() === '') return localFailure('EMPTY_BODY', 'an email without text');
      for (const [name, value] of Object.entries(req.headers)) {
        if (!HEADER_NAME_RE.test(name) || CRLF_RE.test(value)) return localFailure('EMAIL_HEADER_INVALID', 'a custom header is not a single line');
      }
      const messageId = `${req.attemptId}@${domainOf(opts.fromAddress)}`;
      let message: Buffer;
      try {
        message = await composeMessage(req, opts, messageId);
      } catch (error) {
        return localFailure('EMAIL_COMPOSE_FAILED', `the message could not be built (${error instanceof Error ? error.name : 'error'})`);
      }
      if (message.length > MAX_MESSAGE_BYTES) return localFailure('ATTACHMENT_TOO_LARGE', 'the message is larger than this app sends over SMTP');

      let phase: Phase = 'connect';
      let connection: SMTPConnection | null = null;
      try {
        connection = await openConnection(opts);
        await connectStep(connection);
        phase = 'auth';
        await loginStep(connection, opts);
        phase = 'envelope';
        let sent = false;
        // nodemailer pipes this stream only after MAIL FROM, RCPT TO and DATA were accepted.
        const body = new Readable({
          read() {
            if (sent) return;
            sent = true;
            phase = 'data';
            this.push(message);
            this.push(null);
          },
        });
        const conn = connection;
        await step(conn, (done) => conn.send({ from: opts.fromAddress, to: [req.to], size: message.length }, body, (err, info) => done(err ?? null, info)));
        // The message is accepted: how the session ends no longer changes the outcome.
        await quit(conn);
        return { status: 'sent', providerMessageId: messageId, simulated: false };
      } catch (error) {
        closeQuietly(connection, false);
        return sendFailure(error, phase, scrub);
      }
    },
  };
}

// ---- Connection test (no mail is sent) -----------------------------------------------------------------

export type SmtpCheckResult =
  | { ok: true }
  | { ok: false; kind: 'blocked' | 'unreachable' | 'tls' | 'auth' | 'transient' | 'rejected'; message: string };

/** Connect, STARTTLS (or implicit TLS), AUTH, QUIT. MAIL FROM is never sent. */
export async function checkSmtpConnection(opts: SmtpOptions): Promise<SmtpCheckResult> {
  const scrub = scrubber([opts.password]);
  let connection: SMTPConnection | null = null;
  let stage: 'connect' | 'auth' = 'connect';
  try {
    connection = await openConnection(opts);
    await connectStep(connection);
    stage = 'auth';
    await loginStep(connection, opts);
    await quit(connection);
    return { ok: true };
  } catch (error) {
    closeQuietly(connection, false);
    if (error instanceof OutboundBlockedInDemoError) return { ok: false, kind: 'blocked', message: 'outbound connection blocked in DEMO' };
    if (error instanceof BlockedHostError) return { ok: false, kind: 'blocked', message: error.message };
    const e = (error instanceof Error ? error : new Error(String(error))) as SmtpError;
    const message = boundedError(describe(e, scrub));
    const code = typeof e.responseCode === 'number' ? e.responseCode : null;
    if (e.code === 'ETLS' || (code === null && /certificate|tls|ssl/i.test(e.message))) return { ok: false, kind: 'tls', message };
    if (code !== null && code >= 400 && code < 500) return { ok: false, kind: 'transient', message };
    if (code !== null && code >= 500) return { ok: false, kind: stage === 'auth' || e.code === 'EAUTH' ? 'auth' : 'rejected', message };
    return { ok: false, kind: 'unreachable', message };
  }
}
