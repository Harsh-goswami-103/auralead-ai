import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contactKey, normalizeContact } from '@/server/security/contact-key';

const PEPPER = 'p'.repeat(48);

describe('contactKey (C17, ADR-19)', () => {
  it('is a stable hex HMAC-SHA256 over the kind-tagged normalized contact', () => {
    const k = contactKey(PEPPER, 'phone', '+919876543210');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(contactKey(PEPPER, 'phone', '+919876543210')).toBe(k);
    expect(k).toBe(createHmac('sha256', PEPPER).update('phone:+919876543210').digest('hex'));
  });

  it('does not contain or reveal the contact', () => {
    const k = contactKey(PEPPER, 'phone', '+919876543210');
    expect(k).not.toContain('9876543210');
    // A plain sha256 (enumerable) is not what we store.
    expect(k).not.toBe(createHmac('sha256', '').update('+919876543210').digest('hex'));
  });

  it('depends on the pepper', () => {
    expect(contactKey(PEPPER, 'email', 'a@b.in')).not.toBe(contactKey('q'.repeat(48), 'email', 'a@b.in'));
  });

  it('separates kinds so a phone and an email can never collide', () => {
    expect(contactKey(PEPPER, 'phone', '+911234567890')).not.toBe(contactKey(PEPPER, 'email', '+911234567890@x.in'));
  });

  it('gives the same key for equivalent phone spellings', () => {
    const k = contactKey(PEPPER, 'phone', '+919876543210');
    for (const v of ['+91 98765 43210', ' +91-98765-43210 ', '+91 (98765) 43210', '+91.98765.43210', '＋９１９８７６５４３２１０']) {
      expect(contactKey(PEPPER, 'phone', v)).toBe(k);
    }
    expect(contactKey(PEPPER, 'phone', '+919876543211')).not.toBe(k);
  });

  it('gives the same key for equivalent email spellings', () => {
    const k = contactKey(PEPPER, 'email', 'owner@sharma-traders.in');
    for (const v of ['Owner@Sharma-Traders.IN', '  owner@sharma-traders.in\t', 'OWNER@SHARMA-TRADERS.IN']) {
      expect(contactKey(PEPPER, 'email', v)).toBe(k);
    }
  });

  it('normalizeContact returns E.164 for phones and lowercase for emails', () => {
    expect(normalizeContact('phone', '+91 98765-43210')).toBe('+919876543210');
    expect(normalizeContact('email', ' A@B.In ')).toBe('a@b.in');
  });

  it('rejects inputs that are not a normalizable contact (callers normalize national numbers first)', () => {
    for (const bad of ['9876543210', '+0123456', '+91', 'abc', '', '+91 98765 4321O']) {
      expect(() => normalizeContact('phone', bad)).toThrow();
    }
    for (const bad of ['', 'no-at-sign', '@x.in', 'a@', 'a b@x.in', 'a@b@c']) {
      expect(() => normalizeContact('email', bad)).toThrow();
    }
  });

  it('refuses a short or empty pepper', () => {
    expect(() => contactKey('', 'phone', '+919876543210')).toThrow(/pepper/i);
    expect(() => contactKey('short', 'phone', '+919876543210')).toThrow(/pepper/i);
  });
});
