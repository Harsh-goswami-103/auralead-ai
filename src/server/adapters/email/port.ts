/**
 * Email send port (plan §3 adapters/email, §4.4, §7 email rules). Same outcome contract as the
 * WhatsApp port: a transport returns a classified `SendOutcome` and never throws for a provider
 * answer. Every email carries the signed unsubscribe link and the `List-Unsubscribe` /
 * `List-Unsubscribe-Post` headers the dispatch service builds (M2, D4).
 *
 * Implementations: `demo.ts` (DEMO, zero network) and Resend / SMTP (T33, LIVE only).
 */
export type { AmbiguousOutcome, FailedOutcome, FailureClass, SendOutcome, SentOutcome } from '../whatsapp/port';
import type { SendOutcome } from '../whatsapp/port';

export type EmailAttachment = { filename: string; contentType: 'application/pdf'; bytes: Buffer; sha256: string };

export type EmailSendRequest = {
  attemptId: string;
  /** Sent as the provider idempotency key where supported (Resend `Idempotency-Key`, UNVERIFIED). */
  idempotencyKey: string;
  workspaceId: string;
  from: { name: string; address: string };
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
  attachments: EmailAttachment[];
};

export interface EmailTransport {
  readonly label: 'demo' | 'resend' | 'smtp';
  readonly simulated: boolean;
  send(request: EmailSendRequest): Promise<SendOutcome>;
}
