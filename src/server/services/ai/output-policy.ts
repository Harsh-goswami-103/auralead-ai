/**
 * Output policy (G-AI-1, plan §9 "Prompt injection", T10 of 03-security). Runs on every string a
 * generator produced, before anything is persisted. A hit means the text could put a promise,
 * an amount, a link, a stranger's contact or a payment instruction in front of a customer, so the
 * draft is escalated to human review and the offending text is not stored (only the field and the
 * rule are).
 *
 * The checks are deliberately conservative pattern rules. They run on generated text only; the
 * structured proposal (service ids and quantities) is validated separately against the catalog,
 * and prices never come from text at all.
 */

export type PolicyRule =
  | 'CURRENCY_AMOUNT'
  | 'PERCENTAGE'
  | 'URL'
  | 'PHONE'
  | 'EMAIL'
  | 'PAYMENT_PHRASING'
  | 'DISCOUNT_OR_FREE_OFFER'
  | 'CONTROL_CHARACTERS'
  | 'TEMPLATE_VARIABLE_FORMAT';

export type PolicyViolation = { field: string; rule: PolicyRule };

export type OutputPolicyContext = {
  /** The lead's own and the workspace's own addresses (lowercase compare). */
  allowedEmails: readonly string[];
  /** The lead's own and the workspace's own numbers, E.164. */
  allowedPhones: readonly string[];
  /** Exact URLs the server itself inserts (the quote share link). */
  allowedUrls: readonly string[];
};

const CURRENCY = [
  /₹/,
  /\bRs\.?\s*\d/i,
  /\bINR\b/i,
  /\brupees?\b/i,
  /\$\s*\d/,
  /\bUSD\b/i,
  /\d\s*\/-/,
  /\d+(?:\.\d+)?\s*(?:lakhs?|lacs?|crores?)\b/i,
];
const PERCENT = /\d+(?:\.\d+)?\s*(?:%|percent\b|per\s+cent\b)/i;
const URL_SCHEME = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;
// Bare domains; case-sensitive lowercase so a missing space after a sentence (".In the") is not a link.
const BARE_DOMAIN = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|in|net|org|io|co|biz|info|app|xyz|me|link|ly|site|online|shop|store)\b(?:\/[^\s]*)?/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_CANDIDATE = /\+?\d[\d\s().-]{6,}\d/g;
const PAYMENT =
  /\b(?:upi|ifsc|neft|rtgs|imps|paytm|phonepe|g\s?pay|google\s*pay|bitcoin|crypto|bank\s+(?:account|details|transfer)|account\s+(?:number|no\.?)|wire\s+transfer|pay\s+(?:now|in\s+advance|the\s+advance|advance)|advance\s+payment|payment\s+link)\b/i;
const OFFER =
  /\b(?:discount(?:s|ed)?|complimentary|cashback|coupons?|promo\s*codes?|vouchers?|waive[ds]?|no\s+charge|lowest\s+price|guarantee[ds]?|special\s+offer)\b|(?<!feel\s)\bfree\b(?!\s+to\b)/i;
// C0 controls except tab/newline/carriage return, DEL, C1 controls, zero-width and bidi controls, BOM.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/;
// WhatsApp template parameter rules (no newline or tab, no 4+ consecutive spaces); UNVERIFIED
// against current Meta docs until T32 checks them.
const TEMPLATE_VARIABLE = /[\n\r\t]| {4,}/;

const digitsOf = (s: string) => s.replace(/\D/g, '');

function phoneAllowed(candidateDigits: string, allowed: readonly string[]): boolean {
  const tail = candidateDigits.slice(-10);
  return allowed.some((p) => digitsOf(p).slice(-10) === tail);
}

function removeAll(text: string, re: RegExp): string {
  return text.replace(re, ' ');
}

export function checkText(text: string, ctx: OutputPolicyContext, opts: { templateVariable?: boolean } = {}): PolicyRule[] {
  const rules: PolicyRule[] = [];
  const allowedUrls = new Set(ctx.allowedUrls);
  const allowedEmails = new Set(ctx.allowedEmails.map((e) => e.toLowerCase()));

  if (CURRENCY.some((re) => re.test(text))) rules.push('CURRENCY_AMOUNT');
  if (PERCENT.test(text)) rules.push('PERCENTAGE');

  // URLs: scheme/www links first, then bare domains in what is left (emails removed first).
  let rest = text;
  let url = false;
  for (const m of text.matchAll(URL_SCHEME)) {
    const candidate = m[0].replace(/[.,;:!?]+$/, '');
    if (!allowedUrls.has(candidate)) url = true;
    rest = rest.replace(m[0], ' ');
  }
  const withoutEmails = removeAll(rest, EMAIL);
  if (BARE_DOMAIN.test(withoutEmails)) url = true;
  if (url) rules.push('URL');

  let phone = false;
  for (const m of removeAll(text, URL_SCHEME).matchAll(PHONE_CANDIDATE)) {
    const digits = digitsOf(m[0]);
    if (digits.length >= 8 && !phoneAllowed(digits, ctx.allowedPhones)) phone = true;
  }
  if (phone) rules.push('PHONE');

  let email = false;
  for (const m of text.matchAll(EMAIL)) {
    if (!allowedEmails.has(m[0].toLowerCase())) email = true;
  }
  if (email) rules.push('EMAIL');

  if (PAYMENT.test(text)) rules.push('PAYMENT_PHRASING');
  if (OFFER.test(text)) rules.push('DISCOUNT_OR_FREE_OFFER');
  if (CONTROL.test(text)) rules.push('CONTROL_CHARACTERS');
  if (opts.templateVariable && TEMPLATE_VARIABLE.test(text)) rules.push('TEMPLATE_VARIABLE_FORMAT');
  return rules;
}

export type DraftString = { field: string; text: string; templateVariable?: boolean };

/** Violations for each field, in field order then rule order. Never includes the text itself. */
export function checkDraftStrings(fields: readonly DraftString[], ctx: OutputPolicyContext): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  for (const f of fields) {
    for (const rule of checkText(f.text, ctx, { templateVariable: f.templateVariable })) out.push({ field: f.field, rule });
  }
  return out;
}
