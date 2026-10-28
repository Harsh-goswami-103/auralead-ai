/**
 * WhatsApp template sync (T28 seam and DEMO behaviour; ADR-17, P12, plan §5.5).
 *
 * Templates are written in the template studio (ADR-123) or in WhatsApp Manager, approved by Meta, and synced here with the provider's raw
 * status and category strings (never enums), then mapped to intents and variable sources. The
 * DEMO process plays the provider: `syncWhatsAppTemplates` in DEMO creates the workspace's
 * SIMULATED WhatsApp integration when absent (no routing key, the same shape the inbox simulator
 * creates) and every demo template that is absent, approved and rejected ones alike. It never
 * overwrites a stored template ("if absent"), contacts nothing, and is audited as simulated.
 * In LIVE it needs a CONNECTED (or DEGRADED) WhatsApp integration and runs the live sync
 * registered in `live-adapters.ts` (T32, template-sync.ts); anything else is a 422 that names what
 * is missing.
 * Needs `integrations.manage`.
 */
import type { Prisma } from '@/generated/prisma/client';
import { templateShape } from '@/lib/domain/whatsapp-templates';
import { DomainRuleError, NotFoundError } from '@/lib/errors';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { recordAudit } from '@/server/services/audit/record';
import { suggestQuickReplyIntent } from './template-sync';
import type { LiveTemplateSync, TemplateSyncResult } from './types';

export type DemoTemplate = {
  name: string;
  language: string;
  /** Raw provider strings, as WhatsApp Manager reports them. */
  category: string;
  status: string;
  intent: 'FIRST_TOUCH' | 'QUOTE_READY' | 'FOLLOW_UP' | 'CALL_ACK' | null;
  components: Prisma.InputJsonValue;
  /** Positional variables ({{1}}, {{2}}, ...) with what each one holds. */
  variables: Array<{ name: string; description: string; source: string }>;
};

const QUICK_REPLIES = { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Send the quotation' }, { type: 'QUICK_REPLY', text: 'Request a call' }, { type: 'QUICK_REPLY', text: 'Stop' }] };

/** The DEMO WhatsApp Manager: three approved templates (one per mapped intent) and one rejected. */
export const DEMO_WHATSAPP_TEMPLATES: readonly DemoTemplate[] = [
  {
    name: 'quote_ready_v1',
    language: 'en',
    category: 'UTILITY',
    status: 'APPROVED',
    intent: 'QUOTE_READY',
    components: [{ type: 'BODY', text: 'Hello {{1}}, your quotation {{2}} from {{3}} is ready. Tap below to receive it here.' }, QUICK_REPLIES],
    variables: [
      { name: '1', description: 'Customer name', source: 'lead.displayName' },
      { name: '2', description: 'Quotation number', source: 'quote.number' },
      { name: '3', description: 'Business name', source: 'workspace.name' },
    ],
  },
  {
    name: 'welcome_first_touch',
    language: 'en',
    category: 'MARKETING',
    status: 'APPROVED',
    intent: 'FIRST_TOUCH',
    components: [{ type: 'BODY', text: 'Namaste {{1}}, thank you for your interest in {{2}}. Reply here or tap a button below.' }, QUICK_REPLIES],
    variables: [
      { name: '1', description: 'Customer name', source: 'lead.displayName' },
      { name: '2', description: 'Service of interest', source: 'ai.firstTouch' },
    ],
  },
  {
    name: 'call_back_ack',
    language: 'en',
    category: 'UTILITY',
    status: 'APPROVED',
    intent: 'CALL_ACK',
    components: [{ type: 'BODY', text: 'Thanks {{1}}, we have noted your call request. Someone from {{2}} will call you.' }],
    variables: [
      { name: '1', description: 'Customer name', source: 'lead.displayName' },
      { name: '2', description: 'Business name', source: 'workspace.name' },
    ],
  },
  {
    name: 'festive_offer_blast',
    language: 'en',
    category: 'MARKETING',
    status: 'REJECTED',
    intent: null,
    components: [{ type: 'BODY', text: 'Flat 50% off this festive season only! Book now before slots run out.' }],
    variables: [],
  },
];

const SYNCABLE_LIVE = new Set(['CONNECTED', 'DEGRADED']);

/** The demo template's mapping in the T32 shape: body sources, and quick-reply intents proposed from the button texts. */
function demoMapping(t: DemoTemplate): Prisma.InputJsonValue {
  const buttons: Record<string, string> = {};
  for (const q of templateShape(t.components).quickReplies) {
    const intent = suggestQuickReplyIntent(q.text);
    if (intent) buttons[String(q.index)] = intent;
  }
  return { body: Object.fromEntries(t.variables.map((v) => [v.name, v.source])), buttons };
}

type Tx = Prisma.TransactionClient;

export async function syncWhatsAppTemplates(ctx: AppCtx, deps: { liveSync: LiveTemplateSync | null }): Promise<TemplateSyncResult> {
  requireCapability(ctx, 'integrations.manage');
  const workspaceId = requireWorkspace(ctx);
  const workspace = await ctx.db.workspace.findUnique({ where: { id: workspaceId }, select: { mode: true } });
  if (!workspace || workspace.mode !== (ctx.mode === 'demo' ? 'DEMO' : 'LIVE')) throw new NotFoundError({ message: 'workspace mode differs from the process mode' });

  if (ctx.mode === 'live') {
    const row = await ctx.db.integration.findFirst({ where: { kind: 'WHATSAPP_CLOUD' }, select: { id: true, kind: true, status: true, config: true } });
    if (!row || !SYNCABLE_LIVE.has(row.status)) {
      throw new DomainRuleError({
        code: 'INTEGRATION_NOT_CONFIGURED',
        userMessage: 'Connect and verify WhatsApp before syncing templates.',
        safeDetails: { status: row?.status ?? 'NOT_CONFIGURED' },
      });
    }
    if (!deps.liveSync) {
      throw new DomainRuleError({
        code: 'INTEGRATION_NOT_VERIFIED',
        userMessage: 'This WhatsApp connection has not been verified with Meta, so its templates cannot be synced. Run Test connection first.',
      });
    }
    const config = typeof row.config === 'object' && row.config !== null && !Array.isArray(row.config) ? (row.config as Record<string, unknown>) : {};
    return deps.liveSync(ctx, { id: row.id, workspaceId, kind: row.kind, status: row.status, config });
  }

  const now = ctx.clock.now();
  return withTx(ctx.db, async (scoped) => {
    const tx = scoped as unknown as Tx;
    let integration = await tx.integration.findFirst({ where: { workspaceId, kind: 'WHATSAPP_CLOUD' }, select: { id: true } });
    if (!integration) {
      integration = await tx.integration.create({ data: { workspaceId, kind: 'WHATSAPP_CLOUD', status: 'SIMULATED', config: { phoneNumberId: `demo-${workspaceId}` } }, select: { id: true } });
      await recordAudit(tx, ctx, { action: 'integration.simulated.create', targetType: 'Integration', targetId: integration.id, simulated: true, summary: { kind: 'WHATSAPP_CLOUD' } });
    }
    let created = 0;
    let existing = 0;
    for (const t of DEMO_WHATSAPP_TEMPLATES) {
      const found = await tx.whatsAppTemplate.findFirst({ where: { workspaceId, integrationId: integration.id, name: t.name, language: t.language }, select: { id: true } });
      if (found) {
        existing += 1;
        continue;
      }
      await tx.whatsAppTemplate.create({
        data: {
          workspaceId,
          integrationId: integration.id,
          name: t.name,
          language: t.language,
          category: t.category,
          status: t.status,
          components: t.components,
          variableSchema: t.variables.map((v) => ({ name: v.name, description: v.description })),
          intent: t.intent,
          variableMap: demoMapping(t),
          categoryHistory: [{ category: t.category, at: now.toISOString() }],
          syncedAt: now,
        },
      });
      created += 1;
    }
    await recordAudit(tx, ctx, {
      action: 'integration.templates.sync',
      targetType: 'Integration',
      targetId: integration.id,
      simulated: true,
      summary: { kind: 'WHATSAPP_CLOUD', outcome: 'SIMULATED', created, existing },
    });
    return { integrationId: integration.id, simulated: true, created, existing, updated: 0 };
  });
}
