/**
 * R29 (T21 half): approval is the default, auto-send is a per-workspace opt-in that is audited, and
 * automated sends pass the same checks as every other send.
 *  - the workspace default is auto-send off; a thread cannot be set to AUTO until it is on (422);
 *  - enabling and disabling write one audit each (actor, before and after), a repeat writes none;
 *    only `automation.manage` may toggle it (403), AUTO on a thread needs it too;
 *  - with auto-send off again, an AUTO thread's reply becomes a draft for approval (nothing sent);
 *  - WhatsApp quality RED (`Integration.qualityRaw`) pauses automation only: an automated reply is
 *    held back as a draft and a queued automated reply is SKIPPED QUALITY_PAUSED, while a person's
 *    approved send still goes out.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { setPauseHandler } from '@/server/testing/pause';
import { approveAndSendMessage } from '@/server/services/messaging/dispatch';
import { getConversationMode, setConversationAiMode, setWorkspaceAutoSend } from '@/server/services/messaging/conversations';
import { userCtx } from '../quotes/support';
import { DEPS } from '../dispatch/support';
import { attemptsFor, auditsOf, autoConversation, customerSays, inboundMessage, leadWithConversation, repliesTo, WS_A } from './conversation-support';
import { createInboundHarness, type InboundHarness } from './inbound-support';

let h: InboundHarness;
beforeAll(async () => {
  h = await createInboundHarness('auto-send-audit');
}, 120_000);
afterAll(async () => h?.destroy());
afterEach(() => setPauseHandler('dispatch.p1', null));

async function expectStatus(promise: Promise<unknown>, status: number, code?: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).status).toBe(status);
  if (code) expect((error as AppError).code).toBe(code);
}

describe('workspace auto-send is an audited opt-in', () => {
  it('defaults to off, and AUTO is refused on a thread until it is on', async () => {
    expect(await h.db.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: WS_A } })).toMatchObject({ autoSendEnabled: false });
    const { conversation } = await leadWithConversation(h);
    const owner = await h.owner();
    expect(await getConversationMode(owner, { conversationId: conversation.id })).toMatchObject({ aiMode: 'DRAFT', humanTakeover: false, autoSendEnabled: false, autoAvailable: false });
    await expectStatus(setConversationAiMode(owner, { conversationId: conversation.id, aiMode: 'AUTO' }), 422, 'AUTO_SEND_OFF');
    expect(await h.db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).toMatchObject({ aiMode: 'DRAFT', modeVersion: 0 });
  }, 60_000);

  it('enabling and disabling each write one audit; a repeat writes none', async () => {
    const owner = await h.owner();
    const before = (await auditsOf(h, 'workspace.auto_send')).length;
    expect(await setWorkspaceAutoSend(owner, { enabled: true })).toEqual({ enabled: true, changed: true });
    expect(await setWorkspaceAutoSend(owner, { enabled: true })).toEqual({ enabled: true, changed: false });
    expect(await h.db.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: WS_A } })).toMatchObject({ autoSendEnabled: true, updatedBy: owner.actor!.userId });
    h.clock.advance(1_000);
    expect(await setWorkspaceAutoSend(owner, { enabled: false })).toEqual({ enabled: false, changed: true });
    const audits = (await auditsOf(h, 'workspace.auto_send')).slice(before);
    expect(audits.map((a) => [a.actorUserId, a.result, a.summary])).toEqual([
      [owner.actor!.userId, 'SUCCESS', { enabled: true, previous: false }],
      [owner.actor!.userId, 'SUCCESS', { enabled: false, previous: true }],
    ]);
  }, 60_000);

  it('needs automation.manage, and so does AUTO on a thread', async () => {
    const noAutomation = await userCtx(h.db, h.clock, 'employee', 'kesari-crafts');
    await expectStatus(setWorkspaceAutoSend(noAutomation, { enabled: true }), 403);
    const operator = await userCtx(h.db, h.clock, 'employee', 'smile-avenue-dental');
    expect(await setWorkspaceAutoSend(operator, { enabled: true })).toMatchObject({ enabled: true });
    const { conversation } = await leadWithConversation(h);
    expect(await setConversationAiMode(operator, { conversationId: conversation.id, aiMode: 'AUTO' })).toMatchObject({ aiMode: 'AUTO', modeVersion: 1, changed: true });
    h.clock.advance(1_000);
    expect(await setConversationAiMode(operator, { conversationId: conversation.id, aiMode: 'OFF', expectedModeVersion: 1 })).toMatchObject({ aiMode: 'OFF', modeVersion: 2 });
    await expectStatus(setConversationAiMode(operator, { conversationId: conversation.id, aiMode: 'DRAFT', expectedModeVersion: 1 }), 409, 'MODE_VERSION_CONFLICT');
    expect((await auditsOf(h, 'conversation.ai_mode', conversation.id)).map((a) => a.summary)).toEqual([
      { from: 'DRAFT', to: 'AUTO', modeVersion: 1 },
      { from: 'AUTO', to: 'OFF', modeVersion: 2 },
    ]);
  }, 60_000);

  it('with auto-send off again, an AUTO thread drafts its reply for approval and sends nothing', async () => {
    const { lead, owner } = await autoConversation(h);
    await setWorkspaceAutoSend(owner, { enabled: false });
    const calls0 = h.wa.calls.length;
    const wamid = await customerSays(h, lead, 'Do you do root canal treatment?');
    await h.drain();
    expect(h.wa.calls.length).toBe(calls0);
    const [draft] = await repliesTo(h, (await inboundMessage(h, wamid)).id);
    expect(draft).toMatchObject({ status: 'DRAFT' });
    const approval = await h.db.approval.findFirstOrThrow({ where: { messageId: draft!.id } });
    expect(approval.flags).toEqual(expect.arrayContaining(['ai_reply', 'auto_blocked:AUTO_SEND_DISABLED']));
  }, 60_000);
});

describe('WhatsApp quality RED pauses automation only', () => {
  it('an automated reply is held back as a draft; a person can still send it', async () => {
    const { lead } = await autoConversation(h);
    await h.db.integration.updateMany({ where: { workspaceId: WS_A, kind: 'WHATSAPP_CLOUD' }, data: { qualityRaw: 'RED' } });
    try {
      const calls0 = h.wa.calls.length;
      const wamid = await customerSays(h, lead, 'How long does teeth whitening take?');
      await h.drain();
      expect(h.wa.calls.length).toBe(calls0);
      const [draft] = await repliesTo(h, (await inboundMessage(h, wamid)).id);
      expect(draft).toMatchObject({ status: 'DRAFT' });
      const approval = await h.db.approval.findFirstOrThrow({ where: { messageId: draft!.id } });
      expect(approval.flags).toEqual(expect.arrayContaining(['auto_blocked:QUALITY_PAUSED']));

      const sent = await approveAndSendMessage(await h.owner(), { messageId: draft!.id }, DEPS);
      await h.drain();
      expect(h.wa.calls.length).toBe(calls0 + 1);
      expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: sent.attemptId } })).toMatchObject({ state: 'SENT', sendIntent: 'MANUAL_SINGLE' });
    } finally {
      await h.db.integration.updateMany({ where: { workspaceId: WS_A, kind: 'WHATSAPP_CLOUD' }, data: { qualityRaw: null } });
    }
  }, 60_000);

  it('a queued automated reply is SKIPPED QUALITY_PAUSED when quality drops before dispatch', async () => {
    const { lead } = await autoConversation(h);
    const calls0 = h.wa.calls.length;
    const wamid = await customerSays(h, lead, 'Do you do teeth whitening?');
    let held = false;
    setPauseHandler('dispatch.p1', async () => {
      if (held) return;
      held = true;
      await h.db.integration.updateMany({ where: { workspaceId: WS_A, kind: 'WHATSAPP_CLOUD' }, data: { qualityRaw: 'RED' } });
    });
    try {
      await h.drain();
      expect(held).toBe(true);
      expect(h.wa.calls.length).toBe(calls0);
      const [reply] = await repliesTo(h, (await inboundMessage(h, wamid)).id);
      expect((await attemptsFor(h, reply!.id)).map((a) => [a.state, a.reasonCode])).toEqual([['SKIPPED', 'QUALITY_PAUSED']]);
    } finally {
      await h.db.integration.updateMany({ where: { workspaceId: WS_A, kind: 'WHATSAPP_CLOUD' }, data: { qualityRaw: null } });
    }
  }, 60_000);
});
