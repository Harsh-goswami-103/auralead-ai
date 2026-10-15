/**
 * WhatsApp Cloud API webhook payloads (T20). The shape follows Meta's webhook reference for the
 * `messages` field (checked 2026-10-16 against published type definitions; recorded as UNVERIFIED
 * until T32 checks it against a live app): `entry[].changes[].value` carries `metadata`
 * (`phone_number_id` routes it), `contacts`, `messages` and `statuses`. Unknown members are kept
 * (`loose`), unknown message types are accepted and treated as plain inbound messages, and
 * `biz_opaque_callback_data` on a status is the echoed attempt id (UNVERIFIED, plan §4.4).
 *
 * Also the DEMO inbound simulation body (POST /api/webhooks/whatsapp/simulate).
 */
import { z } from 'zod';

const id = z.string().min(1).max(256);

export const waInboundMessageSchema = z.looseObject({
  from: z.string().min(1).max(32),
  id,
  timestamp: z.string().regex(/^\d{1,12}$/),
  type: z.string().min(1).max(40),
  text: z.looseObject({ body: z.string().max(4096) }).optional(),
  button: z.looseObject({ text: z.string().max(256), payload: z.string().max(256).optional() }).optional(),
  interactive: z
    .looseObject({
      type: z.string().max(40),
      button_reply: z.looseObject({ id: z.string().max(256), title: z.string().max(256) }).optional(),
      list_reply: z.looseObject({ id: z.string().max(256), title: z.string().max(256) }).optional(),
    })
    .optional(),
});
export type WaInboundMessage = z.infer<typeof waInboundMessageSchema>;

export const waStatusSchema = z.looseObject({
  id,
  status: z.string().min(1).max(40),
  timestamp: z.string().regex(/^\d{1,12}$/),
  recipient_id: z.string().max(32).optional(),
  biz_opaque_callback_data: z.string().max(512).optional(),
  errors: z.array(z.looseObject({ code: z.union([z.number(), z.string()]).optional() })).optional(),
});
export type WaStatus = z.infer<typeof waStatusSchema>;

export const waChangeValueSchema = z.looseObject({
  messaging_product: z.string().optional(),
  metadata: z.looseObject({ phone_number_id: z.string().min(1).max(64), display_phone_number: z.string().max(32).optional() }),
  contacts: z.array(z.looseObject({ wa_id: z.string().max(32).optional(), profile: z.looseObject({ name: z.string().max(256).optional() }).optional() })).optional(),
  messages: z.array(waInboundMessageSchema).max(100).optional(),
  statuses: z.array(waStatusSchema).max(100).optional(),
});
export type WaChangeValue = z.infer<typeof waChangeValueSchema>;

export const waWebhookSchema = z.looseObject({
  object: z.literal('whatsapp_business_account'),
  entry: z
    .array(
      z.looseObject({
        id: z.string().max(64).optional(),
        changes: z.array(z.looseObject({ field: z.string().max(64), value: z.unknown() })).max(100),
      }),
    )
    .max(100),
});
export type WaWebhook = z.infer<typeof waWebhookSchema>;

/** The DEMO inbound simulator: what the customer "sends" from the lead's own number. */
export const WHATSAPP_SIMULATION_EVENTS = ['text', 'quick_reply_quote', 'quick_reply_call', 'quick_reply_stop', 'start'] as const;
export type WhatsAppSimulationEvent = (typeof WHATSAPP_SIMULATION_EVENTS)[number];

export const whatsappSimulateBodySchema = z.object({
  workspaceSlug: z.string().trim().min(1).max(100).optional(),
  leadId: z.string().min(1).max(64),
  event: z.enum(WHATSAPP_SIMULATION_EVENTS),
  text: z.string().trim().min(1).max(1000).optional(),
});
export type WhatsAppSimulateBody = z.input<typeof whatsappSimulateBodySchema>;
