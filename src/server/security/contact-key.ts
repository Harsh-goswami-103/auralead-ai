/**
 * Pseudonymous contact key for Suppression, ConsentRecord and Conversation (C17, ADR-19):
 * `HMAC-SHA256(SUPPRESSION_PEPPER, "<kind>:<normalized contact>")`, lowercase hex.
 *
 * The kind tag keeps phones and emails in separate key spaces. Phones must already be E.164
 * (national numbers are resolved by src/lib/phone.ts before this point); this module only removes
 * formatting (spaces, dashes, dots, parentheses, full-width forms) so equivalent spellings agree.
 * Changing this normalization makes existing suppressions unmatchable: treat it as a migration.
 */
import { hmacSha256 } from './hmac';

export type ContactKind = 'phone' | 'email';

const MIN_PEPPER_LENGTH = 32;
const E164_RE = /^\+[1-9]\d{6,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

export class ContactKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContactKeyError';
  }
}

export function normalizeContact(kind: ContactKind, value: string): string {
  // NFKC folds full-width digits and the full-width plus sign to ASCII.
  const folded = value.normalize('NFKC').trim();
  if (kind === 'phone') {
    const compact = folded.replace(/[\s().-]/g, '');
    if (!E164_RE.test(compact)) throw new ContactKeyError('Phone contact must be E.164 (+<country><number>)');
    return compact;
  }
  const email = folded.toLowerCase();
  if (!EMAIL_RE.test(email)) throw new ContactKeyError('Email contact is not a valid address');
  return email;
}

export function contactKey(pepper: string, kind: ContactKind, value: string): string {
  if (!pepper || pepper.length < MIN_PEPPER_LENGTH) {
    throw new ContactKeyError(`SUPPRESSION_PEPPER must be at least ${MIN_PEPPER_LENGTH} characters`);
  }
  return hmacSha256(pepper, `${kind}:${normalizeContact(kind, value)}`).toString('hex');
}
