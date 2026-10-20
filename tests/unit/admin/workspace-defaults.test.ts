/**
 * T29: the production defaults a new workspace starts with (ADR-85). They are the same shapes the
 * seed gives every DEMO workspace (scoring v1, pipeline v1 with human approval), they pass the
 * validators the scoring and pipeline services use, and they carry no demo fixture (no services,
 * prices or sample data). The slug rule keeps every workspace reachable at
 * /dashboard/employee/[ws]: no slug may shadow a static segment there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseScoringConfig } from '@/lib/schemas/scoring';
import { RESERVED_WORKSPACE_SLUGS, WorkspaceCreateBody, WORKSPACE_SLUG_PATTERN } from '@/lib/schemas/admin-people';
import { validatePipelineConfig } from '@/server/services/pipeline/validator';
import { DEFAULT_PIPELINE_GRAPH, DEFAULT_SCORING_CONFIG, defaultWorkspaceSettings, isValidTimezone } from '@/server/services/admin/workspace-defaults';
import { PIPELINE_V1, SCORING_V1 } from '../../../prisma/seed/fixtures/configs';
import { REPO_ROOT } from '../../support/spawn';

describe('new workspace defaults', () => {
  it('scoring v1 is the seed shape and passes the scoring schema', () => {
    expect(DEFAULT_SCORING_CONFIG).toEqual(SCORING_V1);
    expect(() => parseScoringConfig(DEFAULT_SCORING_CONFIG)).not.toThrow();
  });

  it('pipeline v1 is the seed graph and validates with human approval and auto-send off', () => {
    expect(DEFAULT_PIPELINE_GRAPH).toEqual(PIPELINE_V1);
    const result = validatePipelineConfig({ graph: DEFAULT_PIPELINE_GRAPH, approvalMode: 'HUMAN' }, { autoSendEnabled: false });
    expect(result.ok).toBe(true);
  });

  it('settings are conservative: no auto-send, no tax line until configured, no booking link, INR', () => {
    const s = defaultWorkspaceSettings({ name: 'Asha Clinic' });
    expect(s).toMatchObject({
      autoSendEnabled: false,
      emailB2bAttestationEnabled: false,
      emailFallbackEnabled: false,
      taxMode: 'NONE',
      taxLabel: null,
      taxBps: null,
      quoteValidityDays: 15,
      gstin: null,
      logoPath: null,
      bookingUrl: null,
      internalWaDailyCap: null,
      internalEmailDailyCap: null,
      currencyDisplay: 'INR',
    });
    expect(s.maxDiscountBps).toBeGreaterThanOrEqual(0);
    expect(s.maxDiscountBps).toBeLessThanOrEqual(10_000);
    expect(s.brandColor).toMatch(/^#[0-9A-F]{6}$/);
    expect(s.termsText).toContain('Indian Rupees');
    expect(s.termsText).not.toMatch(/demo|sample|lorem/i);
  });

  it('accepts IANA time zones only', () => {
    expect(isValidTimezone('Asia/Kolkata')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('workspace slugs', () => {
  it('accepts lowercase words joined by single hyphens', () => {
    for (const ok of ['asha-clinic', 'gym42', 'a1b', 'kesari-crafts-2']) expect(WORKSPACE_SLUG_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ['ab', '-asha', 'asha-', 'asha--clinic', 'Asha', 'asha clinic', 'asha_clinic', 'a'.repeat(49)]) expect(WORKSPACE_SLUG_PATTERN.test(bad), bad).toBe(false);
  });

  it('lowercases the slug and email and defaults the time zone', () => {
    const parsed = WorkspaceCreateBody.parse({ name: ' Asha Clinic ', slug: 'Asha-Clinic', planLabel: 'Starter', ownerEmail: 'Owner@Asha.Example', reason: 'New customer onboarding' });
    expect(parsed).toMatchObject({ name: 'Asha Clinic', slug: 'asha-clinic', ownerEmail: 'owner@asha.example', timezone: 'Asia/Kolkata' });
  });

  it('reserves every static segment beside /dashboard/employee/[ws]', () => {
    const dir = path.join(REPO_ROOT, 'src', 'app', 'dashboard', 'employee');
    const statics = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('[') && !e.name.startsWith('(') && !e.name.startsWith('_'))
      .map((e) => e.name);
    expect(statics.length).toBeGreaterThan(0);
    for (const name of statics) expect(RESERVED_WORKSPACE_SLUGS).toContain(name);
  });
});
