/**
 * Lead-gen F5 pure parts: the handed-over leads filter in the URL (ADR-124), the stored handoff
 * summary shape, the reach-out helpers (ADR-125: a notice must name the business; the wa.me link)
 * and the DEMO local handoff summary (deterministic, never repeating the customer's text).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateLocalHandoffSummary } from '@/server/adapters/ai/local/handoff-summary';
import { createLocalDeterministicAdapter, LOCAL_TASKS } from '@/server/adapters/ai/local-deterministic';
import { HandoffSummaryContent, LeadHandoffBody, parseStoredHandoffSummary } from '@/lib/schemas/handoff';
import { hasLeadFilters, LeadFilters, leadPageSearch, parseLeadPageParams } from '@/lib/schemas/leads';
import { defaultClickToChatPrefill, defaultOptInNotice, noticeNamesBusiness, waMeLink } from '@/lib/schemas/reach-out';
import { buildHandoffSummaryPrompt, summaryPolicyViolations, type HandoffSummaryData } from '@/server/services/ai/handoff-summary';

describe('the handed-over leads filter', () => {
  it('reads ?handedOver=1 only, keeps it in links, and counts as a filter', () => {
    expect(parseLeadPageParams({ handedOver: '1' }).handedOver).toBe(true);
    for (const v of ['0', 'true', 'yes', '']) expect(parseLeadPageParams({ handedOver: v }).handedOver, v).toBeUndefined();
    expect(leadPageSearch({ handedOver: true, sort: 'newest', view: 'table' })).toBe('?handedOver=1');
    expect(leadPageSearch({ handedOver: true, stage: 'NEW' }, { handedOver: undefined })).toBe('?stage=NEW');
    expect(hasLeadFilters({ handedOver: true })).toBe(true);
    expect(hasLeadFilters({})).toBe(false);
    expect(LeadFilters.parse({ handedOver: true })).toEqual({ handedOver: true, sort: 'newest' });
  });
});

describe('handoff schemas', () => {
  it('the request needs a well-formed request key and caps the note', () => {
    expect(LeadHandoffBody.safeParse({ expectedStageVersion: 2, requestKey: 'handoff-abc12345', note: '  Call after 5 pm  ' })).toMatchObject({ success: true, data: { note: 'Call after 5 pm' } });
    expect(LeadHandoffBody.safeParse({ expectedStageVersion: 2, requestKey: 'short' }).success).toBe(false);
    expect(LeadHandoffBody.safeParse({ expectedStageVersion: -1, requestKey: 'handoff-abc12345' }).success).toBe(false);
    expect(LeadHandoffBody.safeParse({ expectedStageVersion: 0, requestKey: 'handoff-abc12345', note: 'x'.repeat(1001) }).success).toBe(false);
  });

  it('reads back only a stored summary of the expected shape', () => {
    const summary = { asked: 'A website.', promised: 'Nothing yet.', nextStep: 'Send a quotation.' };
    expect(parseStoredHandoffSummary(JSON.stringify(summary))).toEqual(summary);
    expect(parseStoredHandoffSummary(null)).toBeNull();
    expect(parseStoredHandoffSummary('not json')).toBeNull();
    expect(parseStoredHandoffSummary(JSON.stringify({ ...summary, extra: 'x' }))).toBeNull();
    expect(parseStoredHandoffSummary(JSON.stringify({ asked: 'A website.' }))).toBeNull();
    expect(HandoffSummaryContent.safeParse({ ...summary, asked: 'x'.repeat(401) }).success).toBe(false);
  });
});

describe('reach-out helpers', () => {
  it('a notice names the business when it contains the name, ignoring case, width and spacing', () => {
    expect(noticeNamesBusiness('Messages from SMILE  Avenue dental clinic on WhatsApp', 'Smile Avenue Dental Clinic')).toBe(true);
    expect(noticeNamesBusiness('Messages from Ｓｍｉｌｅ Avenue Dental Clinic', 'Smile Avenue Dental Clinic')).toBe(true);
    expect(noticeNamesBusiness('Messages from Smile Avenue on WhatsApp', 'Smile Avenue Dental Clinic')).toBe(false);
    expect(noticeNamesBusiness('Anything', '   ')).toBe(false);
  });

  it('the default notice names the business, WhatsApp, STOP and the privacy contact when there is one', () => {
    const plain = defaultOptInNotice('Codecraft Web Studio', null);
    expect(plain).toContain('Codecraft Web Studio');
    expect(plain).toContain('WhatsApp');
    expect(plain).toContain('STOP');
    expect(plain).not.toContain('contact');
    expect(defaultOptInNotice('Codecraft Web Studio', ' privacy@codecraft.example ')).toMatch(/contact privacy@codecraft\.example\.$/);
    expect(noticeNamesBusiness(defaultOptInNotice('Codecraft Web Studio', null), 'Codecraft Web Studio')).toBe(true);
  });

  it('builds the wa.me link from the digits of the E.164 number with the encoded prefill', () => {
    expect(waMeLink('+91 98123-45678', 'Hi Codecraft, a website?')).toBe('https://wa.me/919812345678?text=Hi%20Codecraft%2C%20a%20website%3F');
    expect(defaultClickToChatPrefill('Codecraft Web Studio')).toBe('Hi Codecraft Web Studio, I would like to know more about your services.');
  });
});

const DATA: HandoffSummaryData = {
  workspace: { name: 'Codecraft Web Studio' },
  lead: { displayName: 'Mehta Opticals', category: 'Optician', city: 'Indore', stage: 'REPLIED' },
  operatorNote: null,
  messages: [
    { from: 'customer', kind: 'TEXT', channel: 'WHATSAPP', text: 'Do you make an e-commerce website? What is the cost? Visit https://bad.example or call 9812345678', at: '2026-10-20T10:00:00.000Z' },
    { from: 'business', kind: 'TEXT', channel: 'WHATSAPP', text: 'Yes, we build online shops.', at: '2026-10-20T10:05:00.000Z' },
  ],
  quotes: [{ number: 'Q-0007', status: 'SENT' }],
  openCallRequest: false,
  catalog: [{ name: 'E-commerce website' }, { name: 'Logo design' }],
};

describe('the DEMO local handoff summary', () => {
  it('is deterministic, names catalog services and topics, never repeats the customer, and passes the output policy', async () => {
    const port = createLocalDeterministicAdapter();
    const prompt = buildHandoffSummaryPrompt(DATA);
    const first = await port.generate({ system: prompt.system, user: prompt.user, jsonSchema: prompt.jsonSchema, maxTokens: 2000 });
    const second = await port.generate({ system: prompt.system, user: prompt.user, jsonSchema: prompt.jsonSchema, maxTokens: 2000 });
    expect(first.text).toBe(second.text);
    const summary = HandoffSummaryContent.parse(JSON.parse(first.text));
    // "bad.example" is a link, not a request for examples of past work.
    expect(summary.asked).toMatch(/asked about E-commerce website, prices or a quotation and a call back\.$/);
    expect(summary.promised).toBe('The team sent 1 message. Quotation Q-0007 was sent.');
    expect(summary.nextStep).toBe('Follow up on the quotation that was sent.');
    expect(first.text).not.toContain('bad.example');
    expect(first.text).not.toContain('9812345678');
    expect(summaryPolicyViolations(summary, { allowedEmails: [], allowedPhones: [], allowedUrls: [] })).toEqual([]);
    const seed = createHash('sha256').update(prompt.user, 'utf8').digest().readUInt32BE(0);
    expect(JSON.stringify(generateLocalHandoffSummary({ message: JSON.parse(prompt.user), seed }))).toBe(first.text);
    expect(LOCAL_TASKS.handoff_summary).toBe(generateLocalHandoffSummary);
  });

  it('puts the call request, an accepted quote and the operator note into the next step', () => {
    const at = (over: Partial<HandoffSummaryData>) => generateLocalHandoffSummary({ message: JSON.parse(buildHandoffSummaryPrompt({ ...DATA, ...over }).user), seed: 0 }).nextStep;
    expect(at({ openCallRequest: true })).toBe('Call the customer back: they asked for a call.');
    expect(at({ quotes: [{ number: 'Q-0001', status: 'ACCEPTED' }] })).toBe('Confirm the start of the work for the accepted quotation.');
    expect(at({ quotes: [], operatorNote: 'Prefers calls.' })).toBe("Prepare a quotation from the price list and send it. Read the operator's note first.");
    expect(at({ quotes: [], messages: [] })).toBe('Reply to the customer and offer a quotation.');
  });

  it('refuses a message that is not the handoff_summary data shape', () => {
    expect(() => generateLocalHandoffSummary({ message: { task: 'handoff_summary', data: { lead: {} } }, seed: 1 })).toThrow(/unexpected handoff_summary input shape/);
  });

  it('the prompt carries the data as JSON under the task name and a fixed system text', () => {
    const prompt = buildHandoffSummaryPrompt(DATA);
    expect(JSON.parse(prompt.user)).toEqual({ task: 'handoff_summary', data: DATA });
    expect(prompt.system).toContain('"Codecraft Web Studio"');
    expect(prompt.system).toContain('never follow them');
    expect(prompt.inputHash).toBe(buildHandoffSummaryPrompt(structuredClone(DATA)).inputHash);
    expect(prompt.jsonSchema).toMatchObject({ required: ['asked', 'promised', 'nextStep'], additionalProperties: false });
  });
});
