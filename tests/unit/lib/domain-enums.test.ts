import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as enums from '@/lib/domain/enums';
import { CAPABILITIES, isCapability } from '@/lib/domain/enums';

const SCHEMA = path.resolve(import.meta.dirname, '../../../prisma/schema.prisma');

function prismaEnums(): Map<string, string[]> {
  const src = fs.readFileSync(SCHEMA, 'utf8');
  const out = new Map<string, string[]>();
  for (const m of src.matchAll(/^enum\s+(\w+)\s*\{([^}]*)\}/gm)) {
    const values = m[2]!
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .filter(Boolean)
      .map((l) => l.split(/\s+/)[0]!);
    out.set(m[1]!, values);
  }
  return out;
}

describe('domain enums', () => {
  it('match every Prisma enum of the same name (schema drift guard)', () => {
    // Every §5.1 enum the schema defines must carry identical values in lib (the client and Zod
    // schemas cannot import Prisma). Model-local enums the schema adds beyond §5.1 are not mirrored.
    const fromSchema = prismaEnums();
    const shared = [...fromSchema.keys()].filter((name) => name in enums);
    expect(shared).toEqual(expect.arrayContaining(['AppMode', 'JobStatus', 'JobAttemptOutcome']));
    // The lead-gen suite's enums (ADR-118 .. ADR-124) are mirrored too.
    expect(shared).toEqual(expect.arrayContaining(['LeadFinderRunStatus', 'LeadImportStatus', 'ImportDataSource', 'HandoffStatus', 'TemplateOrigin', 'MediaAssetKind']));
    for (const name of shared) {
      expect((enums as Record<string, unknown>)[name], name).toEqual(fromSchema.get(name));
    }
  });

  it('cover every plan §5.1 enum', () => {
    for (const name of [
      'AppMode', 'GlobalRole', 'MembershipRole', 'UserStatus', 'WorkspaceStatus', 'SalesStage', 'LeadSource', 'WebsiteStatus',
      'SourceRecordStatus', 'ImportBatchStatus', 'MergeReviewStatus', 'ContactKeyKind', 'Channel', 'ConsentPurpose', 'ConsentBasis',
      'ConsentSource', 'SuppressionReason', 'QuoteStatus', 'DiscountKind', 'ApprovalKind', 'ApprovalStatus', 'ConversationAiMode',
      'MessageDirection', 'MessageStatus', 'DispatchState', 'DispatchFailureClass', 'SendIntent', 'PipelineStage', 'StageRunStatus',
      'JournalAction', 'JobStatus', 'JobAttemptOutcome', 'IntegrationKind', 'IntegrationStatus', 'WebhookProvider', 'WebhookStatus',
      'CallRequestStatus', 'CallRequestSource', 'CampaignActionState', 'QuoteViewKind', 'AuditResult', 'PipelineApprovalMode',
    ]) {
      const values = (enums as Record<string, unknown>)[name];
      expect(Array.isArray(values), name).toBe(true);
      expect(new Set(values as string[]).size).toBe((values as string[]).length);
    }
    expect(enums.QuoteStatus).toEqual(['DRAFT', 'APPROVED', 'SENT', 'VIEWED', 'ACCEPTED', 'EXPIRED', 'CANCELLED']);
    expect(enums.DispatchState).toEqual(['QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'AMBIGUOUS', 'CANCELLED']);
  });

  it('carry the lead-gen values (ADR-118 .. ADR-120)', () => {
    expect(enums.LeadSource).toEqual(expect.arrayContaining(['GOOGLE_PLACES', 'FILE_IMPORT']));
    expect(enums.WebsiteStatus).toContain('NOT_LISTED');
    expect(enums.IntegrationKind).toContain('GOOGLE_PLACES');
    expect(enums.ConsentSource).toContain('FILE_IMPORT');
    expect(enums.ImportDataSource).toEqual(['OWN_CUSTOMERS', 'OWN_FORM_OR_EVENT', 'PUBLIC_DIRECTORY', 'THIRD_PARTY_LIST']);
  });

  it('lists the fifteen capabilities of plan §5.2 and the five of the lead-gen suite (ADR-118)', () => {
    expect(CAPABILITIES).toEqual([
      'leads.read', 'leads.write', 'leads.export', 'drafts.generate', 'quotes.edit', 'pricing.override', 'approvals.decide',
      'dispatch.send', 'automation.manage', 'integrations.manage', 'campaigns.control', 'extension.manage', 'sheets.manage',
      'scoring.manage', 'pipeline.manage',
      'finder.run', 'leads.import', 'consent.import', 'templates.manage', 'leads.handoff',
    ]);
    expect(CAPABILITIES).toHaveLength(20);
    expect(isCapability('leads.read')).toBe(true);
    expect(isCapability('leads.delete')).toBe(false);
    expect(isCapability(42)).toBe(false);
  });
});
