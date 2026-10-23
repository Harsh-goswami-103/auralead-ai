/**
 * DEMO template admin (ADR-123, slice F4): plays WhatsApp Manager for the template studio with zero
 * network. A submission is accepted as PENDING with a simulated id derived from the template's
 * name and language; the review (`wa.templateReview`, 30 s later) approves it, or rejects a name
 * containing `reject` with a reason, so the presentation can show both outcomes. A document header
 * gets a simulated sample handle. Every answer is labelled simulated by the caller (audit
 * `simulated: true`, the Simulated chip). Only `adapters/registry.ts` builds it, and only in DEMO.
 */
import { createHash } from 'node:crypto';
import type { GraphCall } from './cloud-api';
import type { HeaderDocument, TemplateAdminPort, TemplateCreated, TemplateCreateRequest } from './template-admin';

/** Seconds between a DEMO submission and its simulated review (ADR-123). */
export const DEMO_TEMPLATE_REVIEW_DELAY_MS = 30_000;

export const DEMO_REJECTION_REASON = 'Simulated review: the name asks for a rejection, so this demo review rejects it (INVALID_FORMAT).';

export type DemoReview = { status: 'APPROVED'; rejectedReason: null } | { status: 'REJECTED'; rejectedReason: string };

export type DemoTemplateAdmin = TemplateAdminPort & {
  readonly label: 'demo';
  readonly simulated: true;
  /** The simulated review outcome for a submitted template. */
  review(template: { name: string }): DemoReview;
};

function ok<T>(data: T): GraphCall<T> {
  return { ok: true, status: 200, data };
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** The simulated review: a name containing `reject` is rejected with a reason; everything else is approved. */
export function demoTemplateReview(template: { name: string }): DemoReview {
  return template.name.toLowerCase().includes('reject') ? { status: 'REJECTED', rejectedReason: DEMO_REJECTION_REASON } : { status: 'APPROVED', rejectedReason: null };
}

export function createDemoTemplateAdmin(): DemoTemplateAdmin {
  return {
    label: 'demo',
    simulated: true,
    async createTemplate(req: TemplateCreateRequest): Promise<GraphCall<TemplateCreated>> {
      return ok({ id: `demo-tpl-${digest(`${req.name}\u0000${req.language}`).slice(0, 16)}`, status: 'PENDING', category: req.category });
    },
    async deleteTemplate(): Promise<GraphCall<{ deleted: true }>> {
      return ok({ deleted: true as const });
    },
    async uploadHeaderDocument(doc: HeaderDocument): Promise<GraphCall<{ handle: string }>> {
      return ok({ handle: `demo-handle-${digest(doc.bytes.toString('base64')).slice(0, 16)}` });
    },
    review: demoTemplateReview,
  };
}
