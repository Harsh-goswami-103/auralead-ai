/**
 * Contact-key dedupe (R12, G-NORM-1). A lead owns one LeadContactKey per E.164 phone (primary and
 * alternates), normalized email and provider id (`<source>:<providerId>`, e.g. a Maps place id).
 * `(workspaceId, kind, value)` is UNIQUE, so two leads in one workspace can never share a key and
 * the same contact in another workspace is a different lead.
 *
 * Matching a new record: every key it carries is looked up; merged leads resolve to the lead they
 * were merged into. Zero leads means new, one means duplicate, two or more means merge review
 * (never an automatic merge).
 */
import type { ContactKeyKind, LeadSource } from '@/generated/prisma/client';
import type { NormalizedLead } from './normalize';

export type ContactKeyValue = { kind: ContactKeyKind; value: string };

export function providerKey(source: LeadSource, providerId: string): string {
  return `${source}:${providerId}`;
}

export function contactKeysFor(lead: Pick<NormalizedLead, 'phoneE164' | 'alternatePhones' | 'emailNormalized'>, source: LeadSource, providerId?: string): ContactKeyValue[] {
  const keys: ContactKeyValue[] = [];
  const seen = new Set<string>();
  const add = (kind: ContactKeyKind, value: string | null | undefined) => {
    if (value === null || value === undefined || value === '') return;
    const id = `${kind}\u0000${value}`;
    if (seen.has(id)) return;
    seen.add(id);
    keys.push({ kind, value });
  };
  add('PHONE', lead.phoneE164);
  for (const alt of lead.alternatePhones) add('PHONE', alt);
  add('EMAIL', lead.emailNormalized);
  if (providerId !== undefined) add('PROVIDER', providerKey(source, providerId));
  return keys;
}

type MatchDb = {
  leadContactKey: { findMany(args: { where: { OR: ContactKeyValue[] }; select: { leadId: true } }): PromiseLike<Array<{ leadId: string }>> };
  lead: { findMany(args: { where: { id: { in: string[] } }; select: { id: true; mergedIntoLeadId: true } }): PromiseLike<Array<{ id: string; mergedIntoLeadId: string | null }>> };
};

/** Distinct surviving lead ids (sorted) that share any of `keys`, through a workspace-scoped client. */
export async function findMatchingLeadIds(db: MatchDb, keys: readonly ContactKeyValue[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await db.leadContactKey.findMany({ where: { OR: keys.map((k) => ({ kind: k.kind, value: k.value })) }, select: { leadId: true } });
  const ids = [...new Set(rows.map((r) => r.leadId))];
  if (ids.length === 0) return [];
  const leads = await db.lead.findMany({ where: { id: { in: ids } }, select: { id: true, mergedIntoLeadId: true } });
  return [...new Set(leads.map((l) => l.mergedIntoLeadId ?? l.id))].sort();
}
