/**
 * `dispatch.email` (plan §4.4, §7 email rules): email sends through the outbox, each with the
 * signed unsubscribe link and List-Unsubscribe headers. See dispatch-run.ts.
 */
import { createDispatchJob, type DispatchJobOptions } from './dispatch-run';

export function createDispatchEmailJob(options: DispatchJobOptions = {}) {
  return createDispatchJob('EMAIL', options);
}

export const dispatchEmailJob = createDispatchEmailJob();
