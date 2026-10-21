/**
 * Instant Form mappings (T35; plan §5.3 MetaFormMapping, P1, ADR-15): which question key fills
 * which lead field, and which question (or custom disclaimer checkbox) records the consent, with
 * the truthy answers, the channel and purpose, and the notice the person agreed to (its sha256 is
 * stored with it, so the consent evidence names the exact text). `integrations.manage`; one row
 * per (integration, form), replaced in place; audited `meta.form_mapping.save` with field names
 * only. In LIVE the workspace's META_ADS integration must exist (its Page and token saved); in DEMO
 * the simulated integration is used (created on first use, as the lead simulation does).
 * A mapping with neither a phone nor an email question would reject every lead
 * (`NO_VALID_CONTACT`), so it is refused.
 */
import { Prisma } from '@/generated/prisma/client';
import { DomainRuleError, NotFoundError } from '@/lib/errors';
import type { MetaFormMappingBody } from '@/lib/schemas/meta';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import type { TxClient } from '@/server/jobs/types';
import { recordAudit } from '@/server/services/audit/record';
import { noticeTextHash } from '@/server/services/messaging/consent';
import { ensureSimulatedMeta } from '@/server/services/webhooks/simulate';

export type SavedFormMapping = { formId: string; integrationId: string; created: boolean; fields: string[]; consent: boolean };

export async function saveMetaFormMapping(ctx: AppCtx, input: Omit<MetaFormMappingBody, 'workspaceSlug'>): Promise<SavedFormMapping> {
  requireCapability(ctx, 'integrations.manage');
  const workspaceId = requireWorkspace(ctx);
  const ws = await ctx.db.workspace.findUnique({ where: { id: workspaceId }, select: { mode: true } });
  if (!ws || ws.mode !== (ctx.mode === 'demo' ? 'DEMO' : 'LIVE')) throw new NotFoundError();
  const fields = Object.entries(input.fields).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '');
  if (!fields.some(([f]) => f === 'phone' || f === 'email')) {
    throw new DomainRuleError({ code: 'MAPPING_NO_CONTACT', userMessage: 'Map at least the phone or the email question: a lead without either is rejected.' });
  }
  if (!fields.some(([f]) => f === 'name')) throw new DomainRuleError({ code: 'MAPPING_NO_NAME', userMessage: 'Map the name question: a lead without a name is rejected.' });

  let integrationId: string;
  if (ctx.mode === 'demo') {
    integrationId = (await ensureSimulatedMeta(ctx)).integrationId;
  } else {
    const row = await ctx.db.integration.findFirst({ where: { kind: 'META_ADS' }, select: { id: true, status: true } });
    if (!row || row.status === 'NOT_CONFIGURED' || row.status === 'REVOKED') {
      throw new DomainRuleError({ code: 'INTEGRATION_NOT_CONFIGURED', userMessage: 'Save the Meta Page ID and access token first; form mappings belong to that integration.' });
    }
    integrationId = row.id;
  }
  const fieldMap = Object.fromEntries(fields.map(([f, q]) => [f, q.trim()]));
  const consentMapping = input.consent
    ? {
        column: input.consent.question,
        truthyValues: input.consent.truthyValues,
        channel: input.consent.channel,
        purpose: input.consent.purpose,
        noticeText: input.consent.noticeText,
        noticeTextHash: noticeTextHash(input.consent.noticeText),
        ...(input.consent.noticeVersion ? { noticeVersion: input.consent.noticeVersion } : {}),
      }
    : null;

  return withTx(ctx.db, async (scoped) => {
    const tx = scoped as unknown as TxClient;
    const existing = await tx.metaFormMapping.findFirst({ where: { workspaceId, integrationId, formId: input.formId }, select: { id: true } });
    const data = { fieldMap: fieldMap as Prisma.InputJsonValue, consentMapping: consentMapping === null ? Prisma.DbNull : (consentMapping as Prisma.InputJsonValue) };
    const row = existing
      ? await tx.metaFormMapping.update({ where: { id: existing.id }, data })
      : await tx.metaFormMapping.create({ data: { workspaceId, integrationId, formId: input.formId, ...data } });
    await recordAudit(tx, ctx, {
      action: 'meta.form_mapping.save',
      targetType: 'MetaFormMapping',
      targetId: row.id,
      simulated: ctx.mode === 'demo',
      summary: { formId: input.formId, fields: fields.map(([f]) => f), consent: consentMapping !== null, created: existing === null },
    });
    return { formId: input.formId, integrationId, created: existing === null, fields: fields.map(([f]) => f), consent: consentMapping !== null };
  });
}
