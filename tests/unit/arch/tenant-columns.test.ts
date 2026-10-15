/**
 * E10 / ADR-42: parses prisma/schema.prisma and fails when a tenant-owned model lacks
 * `workspaceId`, lacks an index that starts with it, or references another tenant model without
 * a composite (workspaceId, parentId) foreign key. The checker is exercised on synthetic schemas
 * first, so a green run over the real schema means "no violations", not "nothing was parsed".
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NULLABLE_TENANT_MODELS, TENANT_MODELS } from '@/server/db/scoped';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

/** Models that are the tenant itself or are platform-wide (identity, sessions, singletons). */
const IDENTITY_ALLOWLIST = new Set(['Workspace', 'User', 'Session', 'SystemSetting', 'TestClock', 'WorkerHeartbeat']);
/** Models whose workspaceId is nullable by design (system rows, platform invites, unrouted webhooks). */
const NULLABLE_ALLOWLIST = new Set(['Job', 'JobAttempt', 'AuditEvent', 'WebhookEvent', 'WebhookRejection', 'Invite']);

type Field = { name: string; type: string; optional: boolean; list: boolean; attrs: string };
type Model = { name: string; fields: Field[]; blockAttrs: string[] };

function parseSchema(source: string): Model[] {
  const models: Model[] = [];
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  for (const match of source.matchAll(re)) {
    const name = match[1] ?? '';
    const body = match[2] ?? '';
    const fields: Field[] = [];
    const blockAttrs: string[] = [];
    for (const raw of body.split('\n')) {
      const line = raw.replace(/\/\/.*$/, '').trim();
      if (!line) continue;
      if (line.startsWith('@@')) {
        blockAttrs.push(line);
        continue;
      }
      const m = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!m) continue;
      fields.push({ name: m[1] ?? '', type: m[2] ?? '', list: Boolean(m[3]), optional: Boolean(m[4]), attrs: m[5] ?? '' });
    }
    models.push({ name, fields, blockAttrs });
  }
  return models;
}

function firstIndexedField(attr: string): string | null {
  const m = /^@@(?:index|unique|id)\(\s*(?:fields:\s*)?\[\s*(\w+)/.exec(attr);
  return m ? (m[1] ?? null) : null;
}

function relationFields(attrs: string): { fields: string[]; references: string[] } | null {
  const f = /fields:\s*\[([^\]]*)\]/.exec(attrs);
  const r = /references:\s*\[([^\]]*)\]/.exec(attrs);
  if (!f || !r) return null;
  const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  return { fields: split(f[1] ?? ''), references: split(r[1] ?? '') };
}

function checkTenantColumns(models: Model[]): string[] {
  const problems: string[] = [];
  const byName = new Map(models.map((m) => [m.name, m]));
  const isRequiredTenant = (name: string) => !IDENTITY_ALLOWLIST.has(name) && !NULLABLE_ALLOWLIST.has(name) && byName.has(name);

  for (const model of models) {
    if (IDENTITY_ALLOWLIST.has(model.name)) continue;
    const ws = model.fields.find((f) => f.name === 'workspaceId');
    if (!ws) {
      problems.push(`${model.name}: no workspaceId column`);
      continue;
    }
    if (ws.type !== 'String' || ws.list) problems.push(`${model.name}: workspaceId must be a String`);
    const nullable = NULLABLE_ALLOWLIST.has(model.name);
    if (ws.optional && !nullable) problems.push(`${model.name}: workspaceId must be required`);
    if (!ws.optional && nullable) problems.push(`${model.name}: listed as nullable but workspaceId is required`);

    const leadsWithWs =
      /@id\b/.test(ws.attrs) || /@unique\b/.test(ws.attrs) || model.blockAttrs.some((a) => firstIndexedField(a) === 'workspaceId');
    if (!leadsWithWs) problems.push(`${model.name}: no index starting with workspaceId`);

    for (const field of model.fields) {
      if (!isRequiredTenant(field.type) || !isRequiredTenant(model.name)) continue;
      const rel = relationFields(field.attrs);
      if (!rel) continue; // back-relation side
      if (rel.fields[0] !== 'workspaceId' || rel.references[0] !== 'workspaceId') {
        problems.push(`${model.name}.${field.name}: tenant reference without composite (workspaceId, ...) foreign key`);
      }
    }
  }
  return problems;
}

function computeTenantSets(models: Model[]): { required: string[]; nullable: string[] } {
  const required: string[] = [];
  const nullable: string[] = [];
  for (const model of models) {
    const ws = model.fields.find((f) => f.name === 'workspaceId');
    if (!ws) continue;
    (ws.optional ? nullable : required).push(model.name);
  }
  return { required: required.sort(), nullable: nullable.sort() };
}

describe('tenant-columns checker on synthetic schemas', () => {
  it('flags a tenant model without workspaceId', () => {
    const problems = checkTenantColumns(parseSchema('model Widget {\n  id String @id\n  name String\n}\n'));
    expect(problems).toEqual(['Widget: no workspaceId column']);
  });

  it('flags a nullable workspaceId outside the allowlist and a missing leading index', () => {
    const problems = checkTenantColumns(parseSchema('model Widget {\n  id String @id\n  workspaceId String?\n  @@index([name, workspaceId])\n}\n'));
    expect(problems).toEqual(['Widget: workspaceId must be required', 'Widget: no index starting with workspaceId']);
  });

  it('flags a single-column reference between tenant models', () => {
    const schema = [
      'model Parent {\n  id String @id\n  workspaceId String\n  kids Kid[]\n  @@unique([workspaceId, id])\n}',
      'model Kid {\n  id String @id\n  workspaceId String\n  parentId String\n  parent Parent @relation(fields: [parentId], references: [id])\n  @@index([workspaceId])\n}',
    ].join('\n');
    expect(checkTenantColumns(parseSchema(schema))).toEqual(['Kid.parent: tenant reference without composite (workspaceId, ...) foreign key']);
  });

  it('accepts a composite reference and an @id workspaceId', () => {
    const schema = [
      'model Parent {\n  id String @id\n  workspaceId String\n  kids Kid[]\n  @@unique([workspaceId, id])\n}',
      'model Kid {\n  id String @id\n  workspaceId String\n  parentId String\n  parent Parent @relation(fields: [workspaceId, parentId], references: [workspaceId, id])\n  @@index([workspaceId])\n}',
      'model Settings {\n  workspaceId String @id\n}',
    ].join('\n');
    expect(checkTenantColumns(parseSchema(schema))).toEqual([]);
  });
});

describe('prisma/schema.prisma', () => {
  const models = parseSchema(readFileSync(path.join(repoRoot, 'prisma/schema.prisma'), 'utf8'));

  it('parses every model', () => {
    expect(models.length).toBeGreaterThanOrEqual(45);
    for (const name of ['PriceEntry', 'QuoteItem', 'JobAttempt', 'PipelineStageRun', 'Suppression', 'WebhookEvent']) {
      expect(models.some((m) => m.name === name)).toBe(true);
    }
  });

  it('gives every tenant model a workspaceId, a leading index, and composite tenant references (E10)', () => {
    expect(checkTenantColumns(models)).toEqual([]);
  });

  it('keeps the scoped client tenant list in sync with the schema', () => {
    const { required, nullable } = computeTenantSets(models);
    expect([...NULLABLE_TENANT_MODELS].sort()).toEqual(nullable);
    expect([...TENANT_MODELS].sort()).toEqual([...required, ...nullable].sort());
  });
});
