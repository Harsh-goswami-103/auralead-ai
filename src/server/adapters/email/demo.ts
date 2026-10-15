/**
 * DEMO email transport (plan §4.2, R1). Records the would-be send (subject, recipient tail,
 * attachment hash, presence of the unsubscribe headers) in the demo outbox and returns a simulated
 * provider id derived from the attempt id. No socket is ever opened.
 */
import type { Clock } from '@/lib/clock';
import { tail, type DemoOutbox } from '../whatsapp/demo';
import type { EmailSendRequest, EmailTransport, SendOutcome } from './port';

export function createDemoEmailTransport(outbox: DemoOutbox, clock: Clock): EmailTransport {
  return {
    label: 'demo',
    simulated: true,
    async send(request: EmailSendRequest): Promise<SendOutcome> {
      const providerMessageId = `demo.email.${request.attemptId}`;
      outbox.record({
        channel: 'EMAIL',
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        workspaceId: request.workspaceId,
        providerMessageId,
        toTail: tail(request.to),
        kind: request.headers['List-Unsubscribe'] ? 'email+unsubscribe' : 'email',
        templateName: null,
        subject: request.subject,
        attachmentSha256: request.attachments[0]?.sha256 ?? null,
        recordedAt: clock.now().toISOString(),
      });
      return { status: 'sent', providerMessageId, simulated: true };
    },
  };
}
