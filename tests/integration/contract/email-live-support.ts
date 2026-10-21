/**
 * LIVE email helpers for T33 (on the T32 LIVE harness): Resend and SMTP integrations stored exactly
 * as the credential writer stores them (envelopes under the harness key ring, AAD per field, the
 * Resend routing key), a lead with an email opt-in, one queued email through the outbox, and the
 * LIVE process runtime installed so the webhook routes run as in the app.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withTx } from '@/server/db/tx';
import { contactKey } from '@/server/security/contact-key';
import { credentialAad, encryptSecret } from '@/server/security/secrets';
import { queueOutboundMessage } from '@/server/services/messaging/dispatch';
import { removeDir } from '../../support/db';
import { testConfig, uninstallRuntime, useRuntime as installTestRuntime } from '../auth/support';
import { KEY_RING, NOW, PEPPER, type LiveHarness } from '../integrations/live-support';

export const RESEND_KEY = 're_contractTestKey000000000000000000wxyz';
export const SMTP_PASSWORD = 'smtp pass W0rd!';

type Status = 'CONNECTED' | 'CONFIGURED_UNVERIFIED' | 'DEGRADED' | 'ERROR' | 'REVOKED';

async function storeIntegration(h: LiveHarness, kind: 'EMAIL_RESEND' | 'EMAIL_SMTP', config: Record<string, string>, secrets: Record<string, string>, opts: { status?: Status; routingKey?: string | null }) {
  const existing = await h.db.integration.findFirst({ where: { workspaceId: h.workspaceId, kind } });
  const row = existing ?? (await h.db.integration.create({ data: { workspaceId: h.workspaceId, kind, status: opts.status ?? 'CONNECTED', config } }));
  const envelopes = Object.fromEntries(Object.entries(secrets).map(([field, value]) => [field, encryptSecret(KEY_RING, value, credentialAad({ workspaceId: h.workspaceId, integrationId: row.id, field }))]));
  return h.db.integration.update({
    where: { id: row.id },
    data: {
      status: opts.status ?? 'CONNECTED',
      config,
      secrets: envelopes,
      secretLast4: Object.fromEntries(Object.keys(secrets).map((f) => [f, { last4: null, updatedAt: NOW }])),
      lastErrorCode: null,
      lastErrorRedacted: null,
      ...(opts.routingKey !== undefined ? { routingKey: opts.routingKey } : {}),
    },
  });
}

export function storeResend(h: LiveHarness, opts: { status?: Status; webhookSecret?: string | null; routingKey?: string | null; fromAddress?: string; fromDomain?: string } = {}) {
  const secrets: Record<string, string> = { apiKey: RESEND_KEY };
  if (opts.webhookSecret) secrets.webhookSecret = opts.webhookSecret;
  return storeIntegration(h, 'EMAIL_RESEND', { fromDomain: opts.fromDomain ?? 'example.com', fromAddress: opts.fromAddress ?? 'quotes@example.com' }, secrets, opts);
}

export function storeSmtp(h: LiveHarness, opts: { status?: Status; port?: string } = {}) {
  return storeIntegration(h, 'EMAIL_SMTP', { host: 'smtp.example.test', port: opts.port ?? '587', username: 'quotes', fromAddress: 'quotes@example.com' }, { password: SMTP_PASSWORD }, opts);
}

let seq = 0;
/** A lead with an email address and an un-withdrawn EMAIL marketing opt-in. */
export async function emailLead(h: LiveHarness) {
  seq += 1;
  const email = `lead${seq}.${Date.parse(NOW) % 100000}@example.net`;
  const lead = await h.db.lead.create({
    data: { workspaceId: h.workspaceId, displayName: `Email Lead ${seq}`, nameNormalized: `email lead ${seq}`, emailNormalized: email, alternatePhones: [], scoreReasons: [], unknownInputs: [], firstSource: 'MANUAL' },
  });
  await h.db.consentRecord.create({
    data: { workspaceId: h.workspaceId, leadId: lead.id, contactKey: contactKey(PEPPER, 'email', email), channel: 'EMAIL', purpose: 'MARKETING', basis: 'OPT_IN', source: 'MANUAL_EVIDENCE', evidence: {}, collectedAt: new Date('2026-10-01T00:00:00.000Z'), recordedAt: new Date('2026-10-01T00:00:00.000Z') },
  });
  return { lead, email };
}

let dedupe = 0;
export async function queueEmail(h: LiveHarness, leadId: string, body = 'Please find the details below.') {
  dedupe += 1;
  const ctx = await h.owner();
  return withTx(ctx.db, (tx) =>
    queueOutboundMessage(tx, ctx, { kind: 'EMAIL', subject: 'Your quotation', body, leadId, channel: 'EMAIL', sendIntent: 'MANUAL_SINGLE', initiatedBy: ctx.actor!.userId, dedupeKey: `t33-email:${dedupe}` }, { contactKeyPepper: PEPPER }),
  );
}

/** Installs the LIVE runtime (same key ring and pepper as the harness) for the webhook routes; returns the cleanup. */
export function installLiveRuntime(h: LiveHarness): () => Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auralead-t33-data-'));
  const config = testConfig('live', {
    AURALEAD_DATA_DIR: dataDir,
    SUPPRESSION_PEPPER: PEPPER,
    CREDENTIALS_KEYRING: JSON.stringify({ k1: KEY_RING.keys.k1!.toString('base64') }),
    CREDENTIALS_ACTIVE_KID: 'k1',
  });
  installTestRuntime(h.db, config, h.clock);
  return async () => {
    uninstallRuntime();
    await removeDir(dataDir);
  };
}
