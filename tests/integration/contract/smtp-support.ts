/**
 * A scripted fake SMTP server for the T33 contract tests: `net.createServer` on 127.0.0.1 only
 * (zero outbound connections), speaking enough ESMTP for nodemailer: greeting, EHLO, STARTTLS
 * upgraded with the test-only self-signed certificate in tests/fixtures/email/tls (SAN
 * smtp.example.test, localhost, 127.0.0.1), AUTH PLAIN / LOGIN, MAIL FROM, RCPT TO, DATA, QUIT.
 * Each step's reply can be scripted (a 4xx or 5xx code, or `silent` to never answer), and the
 * server records the commands it saw (passwords never) and the message it received.
 */
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import type { SmtpSeams } from '@/server/adapters/email/smtp';

const TLS_DIR = path.resolve(import.meta.dirname, '../../fixtures/email/tls');
export const TEST_CERT = readFileSync(path.join(TLS_DIR, 'test-only-cert.pem'));
const TEST_KEY = readFileSync(path.join(TLS_DIR, 'test-only-key.pem'));

export type Reply = string | 'silent';

export type FakeSmtpScript = {
  /** Offer STARTTLS in the EHLO answer (default true). */
  starttls?: boolean;
  greeting?: Reply;
  auth?: Reply;
  mailFrom?: Reply;
  rcptTo?: Reply;
  data?: Reply;
  /** The reply after the message body (`.`). */
  afterData?: Reply;
};

export type FakeSmtp = {
  port: number;
  /** Commands seen, verbs only for AUTH (never the credentials). */
  commands: string[];
  /** Whether the credentials of the last AUTH arrived over TLS. */
  authOverTls: boolean[];
  messages: string[];
  passwordsSeen: string[];
  script: FakeSmtpScript;
  seams: () => SmtpSeams;
  close: () => Promise<void>;
};

export async function startFakeSmtp(script: FakeSmtpScript = {}): Promise<FakeSmtp> {
  const state: FakeSmtp = {
    port: 0,
    commands: [],
    authOverTls: [],
    messages: [],
    passwordsSeen: [],
    script,
    seams: () => ({ connectTo: { host: '127.0.0.1', port: state.port }, tls: { ca: [TEST_CERT] }, timeoutsMs: { connection: 2_000, greeting: 1_000, socket: 400 } }),
    close: async () => undefined,
  };
  const sockets = new Set<net.Socket>();

  const server = net.createServer((raw) => {
    sockets.add(raw);
    raw.on('close', () => sockets.delete(raw));
    let socket: net.Socket | tls.TLSSocket = raw;
    let secure = false;
    let buffer = '';
    let inData = false;
    let message = '';
    let authLogin: 'user' | 'pass' | null = null;

    const send = (reply: Reply | undefined, fallback: string) => {
      const r = reply ?? fallback;
      if (r !== 'silent') socket.write(`${r}\r\n`);
    };

    const onLine = (line: string) => {
      if (inData) {
        if (line === '.') {
          inData = false;
          state.messages.push(message);
          message = '';
          send(state.script.afterData, '250 2.0.0 Ok: queued as FAKE123');
          return;
        }
        message += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
        return;
      }
      if (authLogin === 'user') {
        authLogin = 'pass';
        socket.write('334 UGFzc3dvcmQ6\r\n');
        return;
      }
      if (authLogin === 'pass') {
        authLogin = null;
        state.passwordsSeen.push(Buffer.from(line, 'base64').toString('utf8'));
        state.authOverTls.push(secure);
        send(state.script.auth, '235 2.7.0 Authentication successful');
        return;
      }
      const verb = line.split(' ')[0]!.toUpperCase();
      state.commands.push(verb === 'AUTH' ? `AUTH ${line.split(' ')[1] ?? ''}`.trim() : line.slice(0, 80));
      switch (verb) {
        case 'EHLO': {
          const ext = ['250-smtp.example.test', ...(state.script.starttls !== false && !secure ? ['250-STARTTLS'] : []), '250-AUTH PLAIN LOGIN', '250 SIZE 52428800'];
          socket.write(`${ext.join('\r\n')}\r\n`);
          return;
        }
        case 'HELO':
          socket.write('250 smtp.example.test\r\n');
          return;
        case 'STARTTLS': {
          if (state.script.starttls === false) {
            socket.write('502 5.5.1 STARTTLS not supported\r\n');
            return;
          }
          socket.write('220 2.0.0 Ready to start TLS\r\n');
          raw.removeAllListeners('data');
          const upgraded = new tls.TLSSocket(raw, { isServer: true, key: TEST_KEY, cert: TEST_CERT });
          upgraded.on('data', onData);
          upgraded.on('error', () => undefined);
          socket = upgraded;
          secure = true;
          buffer = '';
          return;
        }
        case 'AUTH': {
          const [, method, initial] = line.split(' ');
          if ((method ?? '').toUpperCase() === 'LOGIN') {
            authLogin = 'user';
            socket.write('334 VXNlcm5hbWU6\r\n');
            return;
          }
          if (initial) state.passwordsSeen.push(Buffer.from(initial, 'base64').toString('utf8').split('\u0000')[2] ?? '');
          state.authOverTls.push(secure);
          send(state.script.auth, '235 2.7.0 Authentication successful');
          return;
        }
        case 'MAIL':
          send(state.script.mailFrom, '250 2.1.0 Ok');
          return;
        case 'RCPT':
          send(state.script.rcptTo, '250 2.1.5 Ok');
          return;
        case 'DATA': {
          const r = state.script.data ?? '354 End data with <CR><LF>.<CR><LF>';
          if (r !== 'silent' && r.startsWith('354')) inData = true;
          send(r, r);
          return;
        }
        case 'RSET':
        case 'NOOP':
          socket.write('250 Ok\r\n');
          return;
        case 'QUIT':
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
          return;
        default:
          socket.write('502 5.5.2 Error: command not recognized\r\n');
      }
    };

    function onData(chunk: Buffer) {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        onLine(line);
      }
    }
    raw.on('data', onData);
    raw.on('error', () => undefined);
    send(state.script.greeting, '220 smtp.example.test ESMTP fake');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  state.port = (server.address() as net.AddressInfo).port;
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return state;
}
