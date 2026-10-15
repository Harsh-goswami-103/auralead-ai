/**
 * AT10 (takeover half), R21, T-b (01-arch §race b): a person taking over a thread blocks a queued
 * automated reply at dispatch, whatever the timing. The automated reply is held at `dispatch.p1`
 * (claimed, before preflight) while the world changes, then released:
 *  - T-b1 takeover: 0 provider calls, attempt SKIPPED HUMAN_TAKEOVER;
 *  - T-b2 takeover then resume: 0 calls (the mode version moved), SKIPPED MODE_CHANGED;
 *  - T-b3 a newer inbound message: 0 calls for the stale reply (CANCELLED NEWER_INBOUND) and a
 *    reply job for the newer message (the regenerated reply), which then sends exactly once.
 * Plus the service rules: takeover and resume bump `modeVersion`, are audited, honour a stale
 * expected version (409), need `leads.write` (403) and never reach another workspace (404); a
 * thread under takeover gets no automated reply generated at all.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { setPauseHandler } from '@/server/testing/pause';
import { REPLY_AUTO_JOB, REPLY_INITIATOR, resumeConversationAi, takeOverConversation } from '@/server/services/messaging/conversations';
import { userCtx } from '../quotes/support';
import { attemptsFor, auditsOf, autoConversation, customerSays, inboundMessage, repliesTo, secondWorker } from './conversation-support';
import { createInboundHarness, type InboundHarness } from './inbound-support';

let h: InboundHarness;
beforeAll(async () => {
  h = await createInboundHarness('takeover-race');
}, 120_000);
afterAll(async () => h?.destroy());
afterEach(() => setPauseHandler('dispatch.p1', null));

/** Runs the queued work with `dispatch.p1` held once by `onHold` (the first automated reply's dispatch). */
async function drainHolding(onHold: () => Promise<void>): Promise<boolean> {
  let held = false;
  setPauseHandler('dispatch.p1', async () => {
    if (held) return;
    held = true;
    await onHold();
  });
  await h.drain();
  setPauseHandler('dispatch.p1', null);
  return held;
}

const FAQ = 'Do you do root canal treatment?';

async function expectStatus(promise: Promise<unknown>, status: number, code?: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).status).toBe(status);
  if (code) expect((error as AppError).code).toBe(code);
}

describe('takeover races an automated reply at dispatch', () => {
  it('T-b1: takeover while the reply is held at P1 gives 0 calls (SKIPPED HUMAN_TAKEOVER)', async () => {
    const { lead, conversationId, owner } = await autoConversation(h);
    const wamid = await customerSays(h, lead, FAQ);
    const calls0 = h.wa.calls.length;

    const held = await drainHolding(async () => {
      await takeOverConversation(owner, { conversationId });
    });
    expect(held).toBe(true);
    expect(h.wa.calls.length).toBe(calls0);

    const inboundRow = await inboundMessage(h, wamid);
    const [reply] = await repliesTo(h, inboundRow.id);
    expect(reply).toMatchObject({ sendIntent: 'AUTOMATED', initiatedBy: REPLY_INITIATOR, status: 'NOT_SENT' });
    expect((await attemptsFor(h, reply!.id)).map((a) => [a.state, a.reasonCode])).toEqual([['SKIPPED', 'HUMAN_TAKEOVER']]);
    const conversation = await h.db.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation).toMatchObject({ humanTakeover: true, aiMode: 'AUTO' });
    expect(reply!.modeVersionAtCreate).toBe(conversation.modeVersion - 1);
    expect(await auditsOf(h, 'conversation.takeover', conversationId)).toHaveLength(1);
  }, 60_000);

  it('T-b2: takeover then resume while held gives 0 calls (SKIPPED MODE_CHANGED)', async () => {
    const { lead, conversationId, owner, modeVersion } = await autoConversation(h);
    const wamid = await customerSays(h, lead, FAQ);
    const calls0 = h.wa.calls.length;

    const held = await drainHolding(async () => {
      await takeOverConversation(owner, { conversationId });
      await resumeConversationAi(owner, { conversationId });
    });
    expect(held).toBe(true);
    expect(h.wa.calls.length).toBe(calls0);

    const [reply] = await repliesTo(h, (await inboundMessage(h, wamid)).id);
    expect(reply!.modeVersionAtCreate).toBe(modeVersion);
    expect((await attemptsFor(h, reply!.id)).map((a) => [a.state, a.reasonCode])).toEqual([['SKIPPED', 'MODE_CHANGED']]);
    expect(await h.db.conversation.findUniqueOrThrow({ where: { id: conversationId } })).toMatchObject({ humanTakeover: false, aiMode: 'AUTO', modeVersion: modeVersion + 2 });
    expect(await auditsOf(h, 'conversation.resume', conversationId)).toHaveLength(1);
  }, 60_000);

  it('T-b3: a newer inbound while held gives 0 calls for the stale reply and a regenerated reply job', async () => {
    const { lead, conversationId } = await autoConversation(h);
    const first = await customerSays(h, lead, FAQ);
    const calls0 = h.wa.calls.length;
    let second = '';

    const held = await drainHolding(async () => {
      second = await customerSays(h, lead, 'And how long does teeth whitening take?');
      // Another worker processes the new message while this one is still held at P1.
      expect(await secondWorker(h).tick()).toBe('ran');
    });
    expect(held).toBe(true);
    expect(h.wa.calls.length).toBe(calls0 + 1);

    const firstRow = await inboundMessage(h, first);
    const secondRow = await inboundMessage(h, second);
    const [stale] = await repliesTo(h, firstRow.id);
    expect((await attemptsFor(h, stale!.id)).map((a) => [a.state, a.reasonCode])).toEqual([['CANCELLED', 'NEWER_INBOUND']]);
    expect(stale!.status).toBe('NOT_SENT');

    const regenerate = await h.db.job.findFirstOrThrow({ where: { type: REPLY_AUTO_JOB, idempotencyKey: `${REPLY_AUTO_JOB}:${secondRow.id}` } });
    expect(regenerate).toMatchObject({ status: 'SUCCEEDED', serialKey: conversationId });
    const [fresh] = await repliesTo(h, secondRow.id);
    expect(fresh).toMatchObject({ status: 'SENT', sendIntent: 'AUTOMATED' });
    expect(fresh!.body).toContain('Teeth whitening (in-clinic)');
    // The one call that went out is the regenerated reply, never the stale one.
    expect(h.wa.calls.at(-1)!.request.body).toBe(fresh!.body);
  }, 60_000);

  it('a thread under takeover gets no automated reply generated', async () => {
    const { lead, conversationId, owner } = await autoConversation(h);
    await takeOverConversation(owner, { conversationId });
    const wamid = await customerSays(h, lead, FAQ);
    const calls0 = h.wa.calls.length;
    await h.drain();
    expect(h.wa.calls.length).toBe(calls0);
    const row = await inboundMessage(h, wamid);
    expect(await repliesTo(h, row.id)).toEqual([]);
    expect(await h.db.job.count({ where: { type: REPLY_AUTO_JOB, idempotencyKey: `${REPLY_AUTO_JOB}:${row.id}` } })).toBe(0);
  }, 60_000);
});

describe('takeover and resume rules', () => {
  it('bump modeVersion once per change, repeat calls are no-ops, a stale expected version is 409', async () => {
    const { conversationId, owner, modeVersion } = await autoConversation(h);
    const taken = await takeOverConversation(owner, { conversationId, expectedModeVersion: modeVersion });
    expect(taken).toMatchObject({ humanTakeover: true, modeVersion: modeVersion + 1, changed: true });
    expect(await takeOverConversation(owner, { conversationId })).toMatchObject({ humanTakeover: true, modeVersion: modeVersion + 1, changed: false });
    await expectStatus(resumeConversationAi(owner, { conversationId, expectedModeVersion: modeVersion }), 409, 'MODE_VERSION_CONFLICT');
    expect(await resumeConversationAi(owner, { conversationId, expectedModeVersion: modeVersion + 1 })).toMatchObject({ humanTakeover: false, modeVersion: modeVersion + 2, changed: true });
    expect(await auditsOf(h, 'conversation.takeover', conversationId)).toHaveLength(1);
  }, 60_000);

  it('need leads.write (403) and never reach another workspace (404)', async () => {
    const { conversationId } = await autoConversation(h);
    const readOnly = await userCtx(h.db, h.clock, 'neha', 'ironpulse-fitness');
    await expectStatus(takeOverConversation(readOnly, { conversationId }), 403);
    const otherWorkspace = await userCtx(h.db, h.clock, 'employee', 'kesari-crafts');
    await expectStatus(takeOverConversation(otherWorkspace, { conversationId }), 404);
    await expectStatus(resumeConversationAi(otherWorkspace, { conversationId }), 404);
    expect(await h.db.conversation.findUniqueOrThrow({ where: { id: conversationId } })).toMatchObject({ humanTakeover: false });
  }, 60_000);
});
