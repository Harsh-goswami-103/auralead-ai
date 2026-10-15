// G-AI-1, plan §9 "Prompt injection": the output policy runs on every generated string before it
// is persisted. A hit escalates the draft to review and the offending text is not stored.
// Rules: currency amounts, percentages, URLs other than the server-inserted quote link, phone
// numbers and emails other than the lead's and the workspace's own, payment phrasing, discount or
// free-offer promises, control and bidi characters, and the WhatsApp variable format rules.
import { describe, expect, it } from 'vitest';
import { checkDraftStrings, checkText, type PolicyRule } from '@/server/services/ai/output-policy';
import { POLICY } from './fixtures';

const rules = (text: string, opts: { templateVariable?: boolean } = {}): PolicyRule[] => checkText(text, POLICY, opts);

describe('checkText', () => {
  it('passes ordinary sales copy, including "feel free" and plain day counts', () => {
    for (const text of [
      'Hi Priya, thanks for reaching out about teeth whitening.',
      'Feel free to reply here with any questions.',
      'Treatment usually completes within 7 days, after 2 visits.',
      'Our clinic in Gurugram is open Monday to Saturday.',
    ]) {
      expect(rules(text), text).toEqual([]);
    }
  });

  it('flags currency amounts in every common Indian form', () => {
    for (const text of ['Only ₹499 today', 'Price Rs. 2,000', 'Rs 500 per visit', 'INR 1500', '1500 rupees', 'just 1,200/-', '2 lakh package', 'USD 30', '$30 only']) {
      expect(rules(text), text).toContain('CURRENCY_AMOUNT');
    }
  });

  it('flags percentages', () => {
    for (const text of ['Get 90% off', '50 percent cheaper', '10 per cent']) expect(rules(text), text).toContain('PERCENTAGE');
  });

  it('flags URLs and bare domains, but allows the server quote link when given', () => {
    for (const text of ['Book at https://evil.example/pay', 'visit www.cheap-dentist.in', 'see bit.ly/abc']) expect(rules(text), text).toContain('URL');
    const link = 'https://app.auralead.example/quote/abcDEF123';
    expect(checkText(`Your quote: ${link}`, { ...POLICY, allowedUrls: [link] }, {})).toEqual([]);
  });

  it('flags phone numbers and emails except the lead and workspace contacts', () => {
    expect(rules('Call me on +91 98765 43210')).toEqual([]);
    expect(rules('Call 98765-43210')).toEqual([]);
    expect(rules('WhatsApp 91234 56789 now')).toContain('PHONE');
    expect(rules('Write to priya.sharma@example.in')).toEqual([]);
    expect(rules('Write to boss@evil.example')).toContain('EMAIL');
  });

  it('flags payment phrasing', () => {
    for (const text of ['Pay via UPI to clinic@okaxis', 'Share your bank account number', 'IFSC code HDFC0001', 'Please pay now to confirm', 'advance payment required']) {
      expect(rules(text), text).toContain('PAYMENT_PHRASING');
    }
  });

  it('flags discount and free-offer promises', () => {
    for (const text of ['We will give you a special discount', 'First session free', 'complimentary cleaning', 'use promo code SMILE', 'cashback on booking']) {
      expect(rules(text), text).toContain('DISCOUNT_OR_FREE_OFFER');
    }
  });

  it('flags control and bidi characters', () => {
    expect(rules('Hello‮evil')).toContain('CONTROL_CHARACTERS');
    expect(rules('Hello\u0007')).toContain('CONTROL_CHARACTERS');
  });

  it('applies the WhatsApp variable rules only to template variables', () => {
    expect(rules('line one\nline two', { templateVariable: true })).toContain('TEMPLATE_VARIABLE_FORMAT');
    expect(rules('tab\there', { templateVariable: true })).toContain('TEMPLATE_VARIABLE_FORMAT');
    expect(rules('four    spaces', { templateVariable: true })).toContain('TEMPLATE_VARIABLE_FORMAT');
    expect(rules('line one\nline two')).toEqual([]);
  });
});

describe('checkDraftStrings', () => {
  it('reports each violation with its field and rule, never the text', () => {
    const v = checkDraftStrings(
      [
        { field: 'followUp', text: 'Get 20% off, pay via UPI' },
        { field: 'email.subject', text: 'Hello' },
        { field: 'templateVariables[1]', text: 'a\nb', templateVariable: true },
      ],
      POLICY,
    );
    expect(v).toEqual([
      { field: 'followUp', rule: 'PERCENTAGE' },
      { field: 'followUp', rule: 'PAYMENT_PHRASING' },
      { field: 'templateVariables[1]', rule: 'TEMPLATE_VARIABLE_FORMAT' },
    ]);
    expect(JSON.stringify(v)).not.toMatch(/UPI|20%/);
  });
});
