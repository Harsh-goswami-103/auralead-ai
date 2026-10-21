/**
 * Contract-test support for the email adapters (T33): the documented-shape Resend fixtures in
 * tests/fixtures/email/documented-shape (derived from Resend's published references through search
 * snippets, not recorded live traffic; see SOURCES.json there), an independent Svix signer for the
 * webhook tests, and a scripted Resend stand-in (the generic scripted HTTP stand-in of the WhatsApp
 * contract tests: it records every request and fails on anything unscripted, so nothing leaves the
 * process).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FakeGraph } from './whatsapp-support';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../fixtures/email/documented-shape');

export function emailFixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as T;
}

type Sources = { files: Record<string, { httpStatus?: number; kind: string; verified: boolean }> };

export function emailFixtureNames(): string[] {
  return Object.keys(emailFixture<Sources>('SOURCES.json').files);
}

export function emailFixtureSources(): Sources {
  return emailFixture<Sources>('SOURCES.json');
}

/** A fixture answer with its documented HTTP status. */
export function resendAnswer(name: string, headers?: Record<string, string>) {
  const status = emailFixtureSources().files[name]?.httpStatus;
  if (status === undefined) throw new Error(`no HTTP status recorded for fixture ${name}`);
  return { status, body: emailFixture(name), ...(headers ? { headers } : {}) };
}

/** The scripted Resend API (same shape as the Graph stand-in). */
export class FakeResend extends FakeGraph {}

/** A fresh `whsec_` signing secret (32 random bytes). */
export function newSigningSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

/** Svix-style signature, computed here independently of the app's verifier. */
export function svixSign(secret: string, id: string, timestampSeconds: number, raw: string | Buffer): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  const mac = createHmac('sha256', key).update(`${id}.${timestampSeconds}.`).update(body).digest('base64');
  return `v1,${mac}`;
}

export function svixHeaders(secret: string, id: string, timestampSeconds: number, raw: string | Buffer): Record<string, string> {
  return { 'svix-id': id, 'svix-timestamp': String(timestampSeconds), 'svix-signature': svixSign(secret, id, timestampSeconds, raw), 'content-type': 'application/json' };
}
