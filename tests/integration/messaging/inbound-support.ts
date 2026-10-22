/**
 * Harness for the T20 inbound tests (WhatsApp and email webhooks, synchronous Stop, quick replies,
 * statuses): the T19 dispatch harness (seeded DEMO DB, scripted transports, in-process worker with
 * the dispatch, render and reconcile jobs) plus the process runtime installed with one config, so
 * the webhook routes run exactly as in the app, and the T20 jobs `webhook.process` and
 * `status.apply` in the same worker.
 *
 * Workspace A owns a WhatsApp Cloud integration routed by `PNID_A` (Integration.routingKey). The
 * Meta app secret, verify token, contact-key pepper and session secret are fixed test values; the
 * SuppressionJournal of the routes is `config.paths.journalDir` (a temp data dir per harness).
 */
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '@/lib/config';
import { createStatusApplyJob } from '@/server/jobs/handlers/status-apply';
import { createWebhookProcessJob } from '@/server/jobs/handlers/webhook-process';
import { createReplyAutoJob } from '@/server/jobs/handlers/reply-auto';
import type { ReplyDeps } from '@/server/services/messaging/conversations';
import { contactKey } from '@/server/security/contact-key';
import type { InboundDeps } from '@/server/services/messaging/inbound';
import { readJournal } from '@/server/services/messaging/suppression-journal';
import { GET as whatsappGet, POST as whatsappPost } from '@/app/api/webhooks/whatsapp/route';
import { POST as emailPost } from '@/app/api/webhooks/email/[provider]/route';
import { GET as unsubscribeGet, POST as unsubscribePost } from '@/app/api/unsubscribe/route';
import { removeDir } from '../../support/db';
import { testConfig, uninstallRuntime, useRuntime as installTestRuntime, type TestRuntime } from '../auth/support';
import { createDispatchHarness, PEPPER, WS_A, type DispatchHarness } from '../dispatch/support';

export { PEPPER, WS_A };
export const APP_SECRET = `meta-app-secret-for-tests-${'m'.repeat(16)}`;
export const VERIFY_TOKEN = 'auralead-verify-token-test';
export const SESSION_SECRET = `inbound-session-secret-${'s'.repeat(32)}`;
export const PNID_A = '109876543210987';
export const ORIGIN = 'http://localhost:3000';

export type InboundHarness = DispatchHarness & {
  config: AppConfig;
  runtime: TestRuntime;
  inboundDeps: InboundDeps;
  integrationId: string;
  routeJournalDir: string;
};

/** `replyDeps` replaces the reply job's dependencies (ADR-122 contract tests pass a scripted AI selection). */
export async function createInboundHarness(label: string, opts: { replyDeps?: () => ReplyDeps } = {}): Promise<InboundHarness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `auralead-data-${label}-`));
  const config = testConfig('demo', {
    AURALEAD_DATA_DIR: dataDir,
    SUPPRESSION_PEPPER: PEPPER,
    META_APP_SECRET: APP_SECRET,
    META_VERIFY_TOKEN: VERIFY_TOKEN,
    SESSION_SECRET,
  });
  const inboundDeps: InboundDeps = { keyRing: config.secrets.credentials!, contactKeyPepper: PEPPER, mode: 'demo' };
  const h = await createDispatchHarness(label, () => [
    createWebhookProcessJob({ deps: () => inboundDeps }),
    createStatusApplyJob({ deps: () => inboundDeps }),
    // T21: inbound text in a DRAFT or AUTO thread queues `reply.auto` (production handler).
    createReplyAutoJob({ mode: () => 'demo', deps: opts.replyDeps ?? (() => ({ contactKeyPepper: PEPPER })) }),
  ]);
  const runtime = installTestRuntime(h.db, config, h.clock);
  const integration = await h.db.integration.create({
    data: { workspaceId: WS_A, kind: 'WHATSAPP_CLOUD', status: 'CONNECTED', config: { phoneNumberId: PNID_A }, routingKey: PNID_A },
  });
  const destroy = h.destroy;
  return {
    ...h,
    config,
    runtime,
    inboundDeps,
    integrationId: integration.id,
    routeJournalDir: config.paths.journalDir,
    destroy: async () => {
      uninstallRuntime();
      await destroy();
      await removeDir(dataDir);
    },
  };
}

// ---- WhatsApp Cloud API webhook payloads (shape per Meta's webhook reference; UNVERIFIED fields noted in docs) ----

export type WaMessageInput = {
  from: string;
  id: string;
  /** Provider time of the message. */
  at: Date;
  text?: string;
  button?: { payload?: string; text: string };
  interactive?: { id: string; title: string };
  name?: string;
};

export function waFrom(phoneE164: string): string {
  return phoneE164.replace(/^\+/, '');
}

const unix = (d: Date) => String(Math.floor(d.getTime() / 1000));

export function waMessageValue(m: WaMessageInput, pnid = PNID_A) {
  const message: Record<string, unknown> = { from: m.from, id: m.id, timestamp: unix(m.at) };
  if (m.button) Object.assign(message, { type: 'button', button: m.button });
  else if (m.interactive) Object.assign(message, { type: 'interactive', interactive: { type: 'button_reply', button_reply: m.interactive } });
  else Object.assign(message, { type: 'text', text: { body: m.text ?? '' } });
  return {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '15550001111', phone_number_id: pnid },
    contacts: [{ profile: { name: m.name ?? 'Test Sender' }, wa_id: m.from }],
    messages: [message],
  };
}

export type WaStatusInput = { id: string; status: 'sent' | 'delivered' | 'read' | 'failed'; at: Date; recipient: string; callbackData?: string; errorCode?: number };

export function waStatusValue(s: WaStatusInput, pnid = PNID_A) {
  const status: Record<string, unknown> = { id: s.id, status: s.status, timestamp: unix(s.at), recipient_id: s.recipient };
  if (s.callbackData) status.biz_opaque_callback_data = s.callbackData;
  if (s.errorCode !== undefined) status.errors = [{ code: s.errorCode, title: 'Provider error' }];
  return { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550001111', phone_number_id: pnid }, statuses: [status] };
}

export function waEnvelope(...values: unknown[]) {
  return { object: 'whatsapp_business_account', entry: [{ id: 'WABA-TEST', changes: values.map((value) => ({ field: 'messages', value })) }] };
}

export function signBody(raw: string | Buffer, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

export function whatsappRequest(raw: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw });
}

const noParams = { params: Promise.resolve({}) };

/** POSTs a payload signed with the test app secret, exactly as Meta would. */
export async function postWhatsApp(payload: unknown): Promise<Response> {
  const raw = JSON.stringify(payload);
  return whatsappPost(whatsappRequest(raw, { 'x-hub-signature-256': signBody(raw) }), noParams);
}

export async function postWhatsAppRaw(raw: string, headers: Record<string, string>): Promise<Response> {
  return whatsappPost(whatsappRequest(raw, headers), noParams);
}

export async function getWhatsApp(query: string): Promise<Response> {
  return whatsappGet(new Request(`${ORIGIN}/api/webhooks/whatsapp?${query}`), noParams);
}

let msgSeq = 0;
export function nextWamid(tag = 'in'): string {
  msgSeq += 1;
  return `wamid.test.${tag}.${String(msgSeq).padStart(5, '0')}.${process.pid}`;
}

/** An inbound message from the lead's phone, signed and posted. */
export async function inbound(lead: { phoneE164: string | null }, m: Omit<WaMessageInput, 'from' | 'id' | 'at'> & { id?: string; at?: Date }, at: Date) {
  const id = m.id ?? nextWamid();
  const res = await postWhatsApp(waEnvelope(waMessageValue({ ...m, from: waFrom(lead.phoneE164!), id, at: m.at ?? at })));
  return { res, id };
}

// ---- Email webhooks and unsubscribe ----------------------------------------------------------------

export function demoEmailSignature(raw: string, sessionSecret = SESSION_SECRET): string {
  const key = createHmac('sha256', sessionSecret).update('auralead.demo-email-webhook.v1').digest();
  return `sha256=${createHmac('sha256', key).update(raw).digest('hex')}`;
}

export async function postEmailEvent(provider: string, event: unknown, opts: { eventId: string; signature?: string | null }): Promise<Response> {
  const raw = JSON.stringify(event);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-auralead-event-id': opts.eventId };
  const signature = opts.signature === undefined ? demoEmailSignature(raw) : opts.signature;
  if (signature !== null) headers['x-auralead-signature'] = signature;
  return emailPost(new Request(`${ORIGIN}/api/webhooks/email/${provider}`, { method: 'POST', headers, body: raw }), { params: Promise.resolve({ provider }) });
}

export async function oneClickUnsubscribe(token: string): Promise<Response> {
  return unsubscribePost(
    new Request(`${ORIGIN}/api/unsubscribe?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    }),
    noParams,
  );
}

export async function formUnsubscribe(token: string): Promise<Response> {
  return unsubscribePost(
    new Request(`${ORIGIN}/api/unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
      body: new URLSearchParams({ token }).toString(),
    }),
    noParams,
  );
}

export async function getUnsubscribe(token: string): Promise<Response> {
  return unsubscribeGet(new Request(`${ORIGIN}/api/unsubscribe?token=${encodeURIComponent(token)}`), noParams);
}

// ---- Assertions helpers ----------------------------------------------------------------------------

export function phoneKey(phoneE164: string): string {
  return contactKey(PEPPER, 'phone', phoneE164);
}

export function emailKey(email: string): string {
  return contactKey(PEPPER, 'email', email);
}

export async function activeSuppression(h: InboundHarness, channel: 'WHATSAPP' | 'EMAIL', key: string) {
  return h.db.suppression.findFirst({ where: { workspaceId: WS_A, channel, contactKey: key, clearedAt: null } });
}

export async function routeJournal(h: InboundHarness) {
  return readJournal(h.routeJournalDir);
}

/** Advances the fixed clock and drains until nothing is claimable, `rounds` times. */
export async function advanceAndDrain(h: InboundHarness, stepMs: number, rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    h.clock.advance(stepMs);
    await h.drain();
  }
}
