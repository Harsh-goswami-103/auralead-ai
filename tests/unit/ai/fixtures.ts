/**
 * Shared fixtures for the T14 AI unit tests: a small dental catalog (as the context builder hands
 * it to the model: ids, names, units and quantity bounds, never prices) and a well-formed model
 * output to mutate per case.
 */
import type { CatalogEntry } from '@/server/services/ai/context-builder';
import type { OutputPolicyContext } from '@/server/services/ai/output-policy';

export const CATALOG: CatalogEntry[] = [
  {
    serviceId: 'svc_consult',
    code: 'CONSULT',
    name: 'Dental consultation and X-ray',
    description: 'Examination by a dentist with one digital OPG X-ray.',
    unitLabel: 'visit',
    minQty: 1,
    maxQty: 10_000,
    typicalTimelineDays: 1,
  },
  {
    serviceId: 'svc_whiten',
    code: 'WHITEN',
    name: 'Teeth whitening (in-clinic)',
    description: 'One 60-minute in-clinic whitening session.',
    unitLabel: 'session',
    minQty: 1,
    maxQty: 10_000,
    typicalTimelineDays: 1,
  },
  {
    serviceId: 'svc_rct',
    code: 'RCT',
    name: 'Root canal treatment',
    description: 'Single-tooth root canal treatment, crown quoted separately.',
    unitLabel: 'tooth',
    minQty: 1,
    maxQty: 8,
    typicalTimelineDays: 7,
  },
];

export const POLICY: OutputPolicyContext = {
  allowedEmails: ['priya.sharma@example.in', 'hello@smileavenue.example'],
  allowedPhones: ['+919876543210'],
  allowedUrls: [],
};

export function validOutput(): Record<string, unknown> {
  return {
    templateVariables: ['Priya', 'Teeth whitening (in-clinic)'],
    followUp: 'Hi Priya, thanks for reaching out about teeth whitening. Would you like us to prepare a quotation for you?',
    email: {
      subject: 'Your teeth whitening enquiry',
      body: 'Hello Priya,\n\nThank you for your interest in teeth whitening at our clinic. We can prepare a detailed quotation for you.\n\nRegards,\nSmile Avenue Dental Clinic',
    },
    proposal: {
      items: [{ serviceId: 'svc_whiten', qty: 1 }],
      scopeText: 'One in-clinic teeth whitening session after a short check-up.',
      timelineText: 'Completed in a single visit.',
    },
  };
}
