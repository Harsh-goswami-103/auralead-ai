/**
 * Request schemas for the super admin routes under /api/admin/** (T24), shared by the routes and
 * the admin panel forms (plan §2: one schema set). Shape only; the services own the rules and
 * answer with a code (for example CONFIRMATION_REQUIRED, AMBIGUOUS_UNRESOLVED).
 *
 * Every admin mutation carries a typed reason, stored on its audit row.
 */
import { z } from 'zod';

export const ADMIN_REASON_MIN = 5;
export const ADMIN_REASON_MAX = 500;

export const adminReason = z.string().trim().min(ADMIN_REASON_MIN).max(ADMIN_REASON_MAX);

/** The text an operator types to requeue an AMBIGUOUS send (plan §4.4: no blind resend). */
export const RESEND_CONFIRM_TEXT = 'RESEND';

export const JobCancelBody = z.object({ reason: adminReason }).strict();
export type JobCancelBody = z.infer<typeof JobCancelBody>;

export const JobRetryBody = z.object({ reason: adminReason }).strict();
export type JobRetryBody = z.infer<typeof JobRetryBody>;

export const AttemptResolveBody = z
  .object({
    attemptId: z.string().min(1).max(64),
    /** DELIVERED: positive evidence the message arrived. NOT_DELIVERED: verified it did not. */
    resolution: z.enum(['DELIVERED', 'NOT_DELIVERED']),
    /** NOT_DELIVERED only: queue attempt N+1 through the full preflight. */
    requeue: z.boolean().default(false),
    reason: adminReason,
    confirmText: z.string().max(40).optional(),
  })
  .strict();
export type AttemptResolveBody = z.infer<typeof AttemptResolveBody>;

export const OutboundPauseBody = z.object({ paused: z.boolean(), reason: adminReason }).strict();
export type OutboundPauseBody = z.infer<typeof OutboundPauseBody>;
