/**
 * The reach-out panel's server side (ADR-125, lead-gen slice F5): how an operator starts a lawful
 * WhatsApp conversation with a lead that has no opt-in (Places and plain-import leads, ADR-15).
 *
 * - `loadReachOut(ctx)`: the workspace's opt-in notice (or the default one, which names the
 *   business, the channel, STOP and the privacy contact), the click-to-chat link built from the
 *   WHATSAPP_CLOUD integration's `displayPhoneNumber`, and what the viewer may do. Reads only.
 * - `updateReachOutSettings(ctx, input)`: the workspace's `whatsappOptInNotice` and
 *   `privacyContact` (`automation.manage`; an OWNER holds it). A notice that does not name the
 *   business is refused (422 NOTICE_MISSING_BUSINESS_NAME). Audited `workspace.reach_out` with the
 *   names of the changed fields only.
 * - `buildClickToChat(ctx, { prefill })`: `https://wa.me/<digits>?text=<prefill>`. A prefill that
 *   folds to a START or STOP keyword is refused (422 PREFILL_IS_KEYWORD): the customer's first
 *   message would subscribe or unsubscribe them instead of starting a chat. Nothing is stored or
 *   sent; the link is for the business's own channels (email signature, website, visiting card).
 *
 * Recording the opt-in itself is `grantManualConsent` (services/messaging/consent.ts), which needs
 * the notice and `evidence.method` for a WhatsApp MARKETING opt-in.
 */
import { DomainRuleError } from '@/lib/errors';
import {
  defaultClickToChatPrefill,
  defaultOptInNotice,
  noticeNamesBusiness,
  waMeLink,
  type ClickToChatResultDto,
  type ReachOutDto,
  type ReachOutSettingsBody,
} from '@/lib/schemas/reach-out';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { recordAudit } from '@/server/services/audit/record';
import { foldKeyword, START_KEYWORDS, STOP_KEYWORDS } from '@/server/services/messaging/quick-replies';

const E164 = /^\+[1-9]\d{7,14}$/;
const UNUSABLE_STATUSES = new Set(['NOT_CONFIGURED', 'REVOKED']);
const KEYWORDS = new Set([...STOP_KEYWORDS, ...START_KEYWORDS].map(foldKeyword));

/** True when the text, folded as inbound messages are folded, is a whole-message START or STOP keyword. */
export function isKeywordPrefill(text: string): boolean {
  return KEYWORDS.has(foldKeyword(text));
}

export function assertPrefillNotKeyword(prefill: string): void {
  if (isKeywordPrefill(prefill)) {
    throw new DomainRuleError({
      code: 'PREFILL_IS_KEYWORD',
      userMessage: 'This text is a WhatsApp START or STOP keyword: a customer who sends it would subscribe or unsubscribe instead of starting a chat. Write a sentence instead.',
    });
  }
}

type DisplayNumber = { available: true; displayPhoneNumber: string; simulated: boolean } | { available: false; reason: 'NOT_CONFIGURED' | 'NO_DISPLAY_NUMBER' };

/** The workspace's WhatsApp display number from its WHATSAPP_CLOUD integration config. */
async function displayNumber(ctx: AppCtx): Promise<DisplayNumber> {
  const rows = await ctx.db.integration.findMany({ where: { kind: 'WHATSAPP_CLOUD' }, select: { status: true, config: true }, orderBy: { id: 'asc' } });
  const usable = rows.filter((r) => !UNUSABLE_STATUSES.has(r.status));
  if (usable.length === 0) return { available: false, reason: 'NOT_CONFIGURED' };
  for (const row of usable) {
    const value = (row.config as { displayPhoneNumber?: unknown } | null)?.displayPhoneNumber;
    if (typeof value === 'string' && E164.test(value.trim())) return { available: true, displayPhoneNumber: value.trim(), simulated: row.status === 'SIMULATED' };
  }
  return { available: false, reason: 'NO_DISPLAY_NUMBER' };
}

async function workspaceFacts(ctx: AppCtx) {
  const workspaceId = requireWorkspace(ctx);
  const [workspace, settings] = await Promise.all([
    ctx.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { slug: true, name: true } }),
    ctx.db.workspaceSettings.findFirst({ select: { whatsappOptInNotice: true, privacyContact: true } }),
  ]);
  return { workspace, settings: { whatsappOptInNotice: settings?.whatsappOptInNotice ?? null, privacyContact: settings?.privacyContact ?? null } };
}

export async function loadReachOut(ctx: AppCtx): Promise<ReachOutDto> {
  requireCapability(ctx, 'leads.read');
  const [{ workspace, settings }, number] = await Promise.all([workspaceFacts(ctx), displayNumber(ctx)]);
  const own = settings.whatsappOptInNotice;
  const prefill = defaultClickToChatPrefill(workspace.name);
  return {
    workspace,
    noticePrefill: own ?? defaultOptInNotice(workspace.name, settings.privacyContact),
    noticeIsDefault: own === null,
    settings,
    clickToChat: number.available
      ? { available: true, displayPhoneNumber: number.displayPhoneNumber, prefill, link: waMeLink(number.displayPhoneNumber, prefill), simulated: number.simulated }
      : { available: false, reason: number.reason },
    permissions: { canRecordOptIn: hasCapability(ctx, 'leads.write'), canManageSettings: hasCapability(ctx, 'automation.manage') },
  };
}

const blankToNull = (v: string | null) => (v === null || v.trim() === '' ? null : v.trim());

export type ReachOutSettingsResult = { whatsappOptInNotice: string | null; privacyContact: string | null; changed: string[] };

export async function updateReachOutSettings(ctx: AppCtx, input: Pick<ReachOutSettingsBody, 'whatsappOptInNotice' | 'privacyContact'>): Promise<ReachOutSettingsResult> {
  requireCapability(ctx, 'automation.manage');
  const workspaceId = requireWorkspace(ctx);
  const notice = blankToNull(input.whatsappOptInNotice);
  const privacyContact = blankToNull(input.privacyContact);
  return withTx(ctx.db, async (tx) => {
    const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } });
    if (notice !== null && !noticeNamesBusiness(notice, workspace.name)) {
      throw new DomainRuleError({
        code: 'NOTICE_MISSING_BUSINESS_NAME',
        userMessage: `The notice must name the business ("${workspace.name}"), so customers know who will message them.`,
        safeDetails: { issues: [{ path: 'whatsappOptInNotice', message: 'must contain the business name' }] },
      });
    }
    const current = await tx.workspaceSettings.findFirst({ select: { whatsappOptInNotice: true, privacyContact: true } });
    if (!current) throw new DomainRuleError({ code: 'SETTINGS_MISSING', userMessage: 'This workspace has no settings yet. Ask a super admin to finish setting it up.' });
    const changed = [...(current.whatsappOptInNotice !== notice ? ['whatsappOptInNotice'] : []), ...(current.privacyContact !== privacyContact ? ['privacyContact'] : [])];
    if (changed.length === 0) return { whatsappOptInNotice: notice, privacyContact, changed };
    await tx.workspaceSettings.updateMany({ data: { whatsappOptInNotice: notice, privacyContact, updatedBy: ctx.actor?.userId ?? `system:${ctx.kind}` } });
    await recordAudit(tx, ctx, { action: 'workspace.reach_out', targetType: 'Workspace', targetId: workspaceId, summary: { fields: changed } });
    return { whatsappOptInNotice: notice, privacyContact, changed };
  });
}

export async function buildClickToChat(ctx: AppCtx, input: { prefill: string }): Promise<ClickToChatResultDto> {
  requireCapability(ctx, 'leads.read');
  const prefill = input.prefill.trim();
  assertPrefillNotKeyword(prefill);
  const number = await displayNumber(ctx);
  if (!number.available) {
    throw new DomainRuleError({
      code: 'CLICK_TO_CHAT_NOT_CONFIGURED',
      userMessage:
        number.reason === 'NOT_CONFIGURED'
          ? 'WhatsApp is not connected for this workspace, so there is no number to link to.'
          : 'Add the display phone number to the WhatsApp integration to build a click-to-chat link.',
    });
  }
  return { link: waMeLink(number.displayPhoneNumber, prefill), prefill, displayPhoneNumber: number.displayPhoneNumber };
}
