/**
 * Email provider events (T20) in Resend's webhook event shape (`{ type, created_at, data: {
 * email_id, to[], bounce? } }`, checked against Resend's published examples on 2026-10-16). The
 * DEMO email provider emits exactly this shape; T33's Resend receiver verifies the Svix signature
 * and hands the same parsed event to the same service.
 */
import { z } from 'zod';

export const emailEventSchema = z.looseObject({
  type: z.string().min(1).max(64),
  created_at: z.iso.datetime({ offset: true }),
  data: z.looseObject({
    email_id: z.string().min(1).max(256),
    to: z.array(z.string().max(320)).max(50).optional(),
    bounce: z.looseObject({ type: z.string().max(64).optional(), subType: z.string().max(64).optional() }).optional(),
  }),
});
export type EmailEvent = z.infer<typeof emailEventSchema>;
