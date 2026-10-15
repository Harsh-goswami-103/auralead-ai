/**
 * DEMO WhatsApp transport (plan §4.2, R1, P2). It never opens a socket: it records the would-be
 * send (template, recipient tail, document hash) as one fsynced JSON line in the demo outbox and
 * returns a provider message id derived from the attempt id, labelled simulated. Nothing is
 * delivered and the UI shows it as Simulated.
 *
 * The outbox file (`<STORAGE_DIR>/demo-outbox/<channel>.jsonl`) is also the cross-process record of
 * how many sends were attempted, which the restart and lease tests count.
 */
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Clock } from '@/lib/clock';
import type { SendOutcome, WaSendRequest, WhatsAppTransport } from './port';

export type DemoOutboxEntry = {
  channel: 'WHATSAPP' | 'EMAIL';
  attemptId: string;
  idempotencyKey: string;
  workspaceId: string;
  providerMessageId: string;
  /** Last four characters of the recipient only (no contact data in the outbox). */
  toTail: string;
  kind: string;
  templateName: string | null;
  subject: string | null;
  attachmentSha256: string | null;
  recordedAt: string;
};

export interface DemoOutbox {
  record(entry: DemoOutboxEntry): void;
}

export function demoOutboxDir(storageDir: string): string {
  return path.join(storageDir, 'demo-outbox');
}

function outboxFile(dir: string, channel: DemoOutboxEntry['channel']): string {
  return path.join(dir, `${channel.toLowerCase()}.jsonl`);
}

/** Appends one fsynced line per would-be send. */
export function createFileDemoOutbox(dir: string): DemoOutbox {
  return {
    record(entry) {
      mkdirSync(dir, { recursive: true });
      const file = outboxFile(dir, entry.channel);
      appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
      const fd = openSync(file, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
  };
}

export function readDemoOutbox(dir: string, channel: DemoOutboxEntry['channel']): DemoOutboxEntry[] {
  let text: string;
  try {
    text = readFileSync(outboxFile(dir, channel), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as DemoOutboxEntry);
}

export function tail(value: string): string {
  return value.slice(-4);
}

export function createDemoWhatsAppTransport(outbox: DemoOutbox, clock: Clock): WhatsAppTransport {
  return {
    label: 'demo',
    simulated: true,
    async send(request: WaSendRequest): Promise<SendOutcome> {
      const providerMessageId = `demo.wamid.${request.attemptId}`;
      outbox.record({
        channel: 'WHATSAPP',
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        workspaceId: request.workspaceId,
        providerMessageId,
        toTail: tail(request.to),
        kind: request.document ? `${request.kind}+document` : request.kind,
        templateName: request.template?.name ?? null,
        subject: null,
        attachmentSha256: request.document?.sha256 ?? null,
        recordedAt: clock.now().toISOString(),
      });
      return { status: 'sent', providerMessageId, simulated: true };
    },
  };
}
