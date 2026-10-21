/**
 * The dispatch transport of one workspace and channel (T32; plan §4.2, §4.4, ADR-60). Called by
 * the dispatch handler before its preflight transaction: it reads the workspace's mode and its
 * channel integration, decrypts the credentials (outside any transaction) and asks the adapter
 * registry for the transport. DEMO never loads or decrypts anything and gets the demo transport.
 * LIVE gets the provider adapter or a typed problem (INTEGRATION_NOT_CONFIGURED,
 * CREDENTIAL_UNREADABLE, MODE_MISMATCH), which the handler turns into the NOT_CONFIGURED skip;
 * never a demo transport.
 */
import type { Channel } from '@/generated/prisma/client';
import type { EmailTransport } from '@/server/adapters/email/port';
import { EMAIL_KIND_PREFERENCE, resolveEmailTransport, resolveWhatsAppTransport, type EmailSeams, type GraphSeams, type IntegrationUse, type Resolution } from '@/server/adapters/registry';
import type { WhatsAppTransport } from '@/server/adapters/whatsapp/port';
import type { AppCtx } from '@/server/auth/context';
import { requireWorkspace } from '@/server/auth/guards';
import type { KeyRing } from '@/server/security/secrets';
import { loadIntegrationForUse } from './credentials';

export type TransportDeps = { keyRing: KeyRing | null; graphVersion: string | null; storageDir: string; graph?: GraphSeams; email?: EmailSeams };

/** The workspace's stored mode; a missing workspace reads as the other mode, so the registry refuses it (MODE_MISMATCH). */
async function workspaceMode(ctx: AppCtx): Promise<'DEMO' | 'LIVE'> {
  const ws = await ctx.db.workspace.findUnique({ where: { id: requireWorkspace(ctx) }, select: { mode: true } });
  if (ws) return ws.mode;
  return ctx.mode === 'demo' ? 'LIVE' : 'DEMO';
}

export async function resolveWorkspaceWhatsApp(ctx: AppCtx, deps: TransportDeps): Promise<Resolution<WhatsAppTransport>> {
  const mode = await workspaceMode(ctx);
  const integration = ctx.mode === 'live' ? await loadIntegrationForUse(ctx.db, 'WHATSAPP_CLOUD', deps.keyRing) : null;
  return resolveWhatsAppTransport({ mode: ctx.mode, workspaceMode: mode, integration, graphVersion: deps.graphVersion, clock: ctx.clock, storageDir: deps.storageDir, ...(deps.graph ? { graph: deps.graph } : {}) });
}

export async function resolveWorkspaceEmail(ctx: AppCtx, deps: TransportDeps): Promise<Resolution<EmailTransport>> {
  const mode = await workspaceMode(ctx);
  const integrations: IntegrationUse[] = [];
  if (ctx.mode === 'live') {
    for (const kind of EMAIL_KIND_PREFERENCE) {
      const use = await loadIntegrationForUse(ctx.db, kind, deps.keyRing);
      if (use) integrations.push(use);
    }
  }
  return resolveEmailTransport({ mode: ctx.mode, workspaceMode: mode, integrations, clock: ctx.clock, storageDir: deps.storageDir, ...(deps.email ? { seams: deps.email } : {}) });
}

export function resolveWorkspaceTransport(ctx: AppCtx, channel: Channel, deps: TransportDeps): Promise<Resolution<WhatsAppTransport | EmailTransport>> {
  return channel === 'WHATSAPP' ? resolveWorkspaceWhatsApp(ctx, deps) : resolveWorkspaceEmail(ctx, deps);
}
