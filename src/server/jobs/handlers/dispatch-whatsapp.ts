/**
 * `dispatch.whatsapp` (plan §4.4): WhatsApp sends through the outbox. See dispatch-run.ts.
 */
import { createDispatchJob, type DispatchJobOptions } from './dispatch-run';

export function createDispatchWhatsAppJob(options: DispatchJobOptions = {}) {
  return createDispatchJob('WHATSAPP', options);
}

export const dispatchWhatsAppJob = createDispatchWhatsAppJob();
