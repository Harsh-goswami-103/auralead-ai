/**
 * T32 (plan §4.2 "missing provider credentials produce IntegrationNotConfigured results, never a
 * demo transport", R1): LIVE never reaches a demo transport through the adapter registry.
 *  1. Statically: in src/server/adapters/registry.ts every `live*` function (the LIVE branch) uses
 *     no symbol imported from a demo module, and the live adapter modules (Cloud API, media,
 *     limits, AI connection checks) never import a demo module, directly or transitively.
 *  2. At runtime: for every integration status and credential state, LIVE resolution answers a
 *     Cloud API transport or a typed problem, never a demo or simulated transport.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { FixedClock } from '@/lib/clock';
import { IntegrationStatus } from '@/lib/domain/enums';
import { CHECKABLE_STATUSES, metaLeadsClient, metaMarketingClient, resendApiClient, resolveEmailTransport, resolveWhatsAppTransport, sheetsReadClient, smtpConnectionCheck, whatsAppGraphClient, aiConnectionCheck, type CredentialState, type IntegrationUse } from '@/server/adapters/registry';
// Lead-gen suite resolvers under test (docs/handoff/lead-gen-suite-plan.md §6), each in its slice's block.
// ---- lead-gen F1 finder ----
import { placesCheckClient, resolvePlacesProvider } from '@/server/adapters/registry';
// ---- end F1 ----
// ---- lead-gen F2 import ----

// ---- end F2 ----
// ---- lead-gen F3 chat ----

// ---- end F3 ----
// ---- lead-gen F4 templates ----

// ---- end F4 ----
// ---- lead-gen F5 handoff ----

// ---- end F5 ----
// ---- lead-gen F6 presentation ----

// ---- end F6 ----

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const REGISTRY = 'src/server/adapters/registry.ts';
const DEMO_MODULES = [
  'src/server/adapters/whatsapp/demo.ts',
  'src/server/adapters/email/demo.ts',
  // ---- lead-gen F1 finder ----
  'src/server/adapters/places/demo.ts',
  // ---- end F1 ----
  // ---- lead-gen F2 import ----

  // ---- end F2 ----
  // ---- lead-gen F3 chat ----

  // ---- end F3 ----
  // ---- lead-gen F4 templates ----

  // ---- end F4 ----
  // ---- lead-gen F5 handoff ----

  // ---- end F5 ----
  // ---- lead-gen F6 presentation ----

  // ---- end F6 ----
];
const LIVE_MODULES = [
  'src/server/adapters/whatsapp/cloud-api.ts',
  'src/server/adapters/whatsapp/media.ts',
  'src/server/adapters/whatsapp/limits.ts',
  'src/server/adapters/ai/connection-check.ts',
  // T33
  'src/server/adapters/email/resend.ts',
  'src/server/adapters/email/smtp.ts',
  // T35
  'src/server/adapters/meta/graph.ts',
  // T34
  'src/server/adapters/sheets/google.ts',
  // ---- lead-gen F1 finder ----
  'src/server/adapters/places/google-places.ts',
  // ---- end F1 ----
  // ---- lead-gen F2 import ----

  // ---- end F2 ----
  // ---- lead-gen F3 chat ----

  // ---- end F3 ----
  // ---- lead-gen F4 templates ----

  // ---- end F4 ----
  // ---- lead-gen F5 handoff ----

  // ---- end F5 ----
  // ---- lead-gen F6 presentation ----

  // ---- end F6 ----
];
/** Every `live*` function of the registry (the LIVE branches); a slice lists the ones it adds in its block. */
const LIVE_FUNCTIONS = [
  'liveAiCheck',
  'liveCloudApiOptions',
  'liveEmailTransport',
  'liveGraphClient',
  'liveMetaLeadsClient',
  'liveMetaMarketingClient',
  'liveMetaToken',
  'liveResendClient',
  'liveResendOptions',
  'liveSmtpCheck',
  'liveSheetsClient',
  'liveSmtpOptions',
  'liveWhatsAppTransport',
  // ---- lead-gen F1 finder ----
  'livePlacesClient',
  // ---- end F1 ----
  // ---- lead-gen F2 import ----

  // ---- end F2 ----
  // ---- lead-gen F3 chat ----

  // ---- end F3 ----
  // ---- lead-gen F4 templates ----

  // ---- end F4 ----
  // ---- lead-gen F5 handoff ----

  // ---- end F5 ----
  // ---- lead-gen F6 presentation ----

  // ---- end F6 ----
];

function resolve(from: string, spec: string): string | null {
  let base: string | null = null;
  if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  if (!base) return null;
  for (const suffix of ['', '.ts', '.tsx', '/index.ts']) {
    const abs = path.join(repoRoot, base + suffix);
    if (existsSync(abs) && statSync(abs).isFile()) return base + suffix;
  }
  return null;
}

function source(rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, readFileSync(path.join(repoRoot, rel), 'utf8'), ts.ScriptTarget.Latest, true);
}

function imports(rel: string): Array<{ target: string | null; names: string[] }> {
  const out: Array<{ target: string | null; names: string[] }> = [];
  for (const st of source(rel).statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const names: string[] = [];
    const clause = st.importClause;
    if (clause?.name) names.push(clause.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const e of clause.namedBindings.elements) names.push(e.name.text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push(clause.namedBindings.name.text);
    out.push({ target: resolve(rel, st.moduleSpecifier.text), names });
  }
  return out;
}

function reachable(start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const i of imports(f)) if (i.target && i.target.startsWith('src/')) stack.push(i.target);
  }
  return seen;
}

describe('LIVE never imports the demo transport in the registry path (static)', () => {
  it('no live* function of the registry references a demo-module symbol', () => {
    const demoNames = new Set(imports(REGISTRY).filter((i) => i.target !== null && DEMO_MODULES.includes(i.target)).flatMap((i) => i.names));
    expect(demoNames.size).toBeGreaterThan(0); // the DEMO branch does use them
    const sf = source(REGISTRY);
    const liveFns = sf.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && (s.name?.text ?? '').startsWith('live'));
    expect(liveFns.map((f) => f.name!.text).sort()).toEqual([...LIVE_FUNCTIONS].sort());
    const used: string[] = [];
    for (const fn of liveFns) {
      const visit = (n: ts.Node) => {
        if (ts.isIdentifier(n) && demoNames.has(n.text)) used.push(`${fn.name!.text}: ${n.text}`);
        ts.forEachChild(n, visit);
      };
      visit(fn);
    }
    expect(used).toEqual([]);
  });

  it('the live adapter modules never reach a demo module', () => {
    for (const m of LIVE_MODULES) {
      const reached = [...reachable(m)].filter((f) => DEMO_MODULES.includes(f));
      expect(reached, m).toEqual([]);
    }
  });
});

describe('LIVE resolution never yields a demo transport (runtime)', () => {
  const clock = new FixedClock('2026-10-20T06:00:00.000Z');
  const creds: CredentialState[] = [
    { state: 'ok', values: { accessToken: 'EAAGarchtesttoken000000000000000' } },
    { state: 'missing', fields: ['accessToken'] },
    { state: 'unreadable', field: 'accessToken' },
  ];

  it('every status x credential state x graph version answers Cloud API or a typed problem', () => {
    for (const status of IntegrationStatus) {
      for (const credentials of creds) {
        for (const graphVersion of ['v24.0', null]) {
          const r = resolveWhatsAppTransport({
            mode: 'live',
            workspaceMode: 'LIVE',
            integration: { id: 'int_1', kind: 'WHATSAPP_CLOUD', status, config: { phoneNumberId: '109876543210987', wabaId: '209876543210987' }, credentials },
            graphVersion,
            clock,
            storageDir: '/nonexistent',
          });
          if (r.ok) {
            expect(r.value).toMatchObject({ label: 'cloud-api', simulated: false });
            expect(['CONNECTED', 'DEGRADED']).toContain(status);
            expect(credentials.state).toBe('ok');
            expect(graphVersion).not.toBeNull();
          } else {
            expect(['INTEGRATION_NOT_CONFIGURED', 'CREDENTIAL_UNREADABLE']).toContain(r.code);
          }
        }
      }
    }
    expect(resolveWhatsAppTransport({ mode: 'live', workspaceMode: 'LIVE', integration: null, graphVersion: 'v24.0', clock, storageDir: '/x' })).toMatchObject({ ok: false, code: 'INTEGRATION_NOT_CONFIGURED' });
    expect(resolveWhatsAppTransport({ mode: 'live', workspaceMode: 'DEMO', integration: null, graphVersion: 'v24.0', clock, storageDir: '/x' })).toMatchObject({ ok: false, code: 'MODE_MISMATCH' });
  });

  it('T33: every email status x credential state answers Resend, SMTP or a typed problem, never the demo transport; Resend wins when both are usable', () => {
    const resendCreds: CredentialState[] = [{ state: 'ok', values: { apiKey: 're_archtestkey000000000000' } }, { state: 'missing', fields: ['apiKey'] }, { state: 'unreadable', field: 'apiKey' }];
    const smtpCreds: CredentialState[] = [{ state: 'ok', values: { password: 'pw' } }, { state: 'missing', fields: ['password'] }, { state: 'unreadable', field: 'password' }];
    const resend = (status: (typeof IntegrationStatus)[number], credentials: CredentialState): IntegrationUse => ({ id: 'r1', kind: 'EMAIL_RESEND', status, config: { fromDomain: 'example.com', fromAddress: 'q@example.com' }, credentials });
    const smtp = (status: (typeof IntegrationStatus)[number], credentials: CredentialState): IntegrationUse => ({ id: 's1', kind: 'EMAIL_SMTP', status, config: { host: 'smtp.example.com', port: '587', username: 'u', fromAddress: 'q@example.com' }, credentials });
    for (const rs of IntegrationStatus) {
      for (const rc of resendCreds) {
        for (const ss of IntegrationStatus) {
          for (const sc of smtpCreds) {
            const r = resolveEmailTransport({ mode: 'live', workspaceMode: 'LIVE', integrations: [resend(rs, rc), smtp(ss, sc)], clock, storageDir: '/x' });
            const resendUsable = ['CONNECTED', 'DEGRADED'].includes(rs);
            const smtpUsable = ['CONNECTED', 'DEGRADED'].includes(ss);
            if (r.ok) {
              expect(r.value.simulated).toBe(false);
              if (resendUsable) expect(r.value.label).toBe('resend');
              else expect(r.value.label).toBe('smtp');
              expect(r.value.label === 'resend' ? rc.state : sc.state).toBe('ok');
            } else {
              expect(['INTEGRATION_NOT_CONFIGURED', 'CREDENTIAL_UNREADABLE']).toContain(r.code);
              if (resendUsable) expect(rc.state).not.toBe('ok');
              else if (smtpUsable) expect(sc.state).not.toBe('ok');
            }
          }
        }
      }
    }
    expect(resolveEmailTransport({ mode: 'live', workspaceMode: 'LIVE', integrations: [], clock, storageDir: '/x' })).toMatchObject({ ok: false, code: 'INTEGRATION_NOT_CONFIGURED' });
    const off = resolveEmailTransport({ mode: 'live', workspaceMode: 'LIVE', integrations: [{ ...resend('CONNECTED', resendCreds[0]!), config: { fromDomain: 'example.com', fromAddress: 'q@other.example' } }], clock, storageDir: '/x' });
    expect(off).toMatchObject({ ok: false, code: 'INTEGRATION_NOT_CONFIGURED', reason: 'the from address is not at the sending domain' });
    const port = resolveEmailTransport({ mode: 'live', workspaceMode: 'LIVE', integrations: [{ ...smtp('CONNECTED', smtpCreds[0]!), config: { host: 'smtp.example.com', port: '6379', username: 'u', fromAddress: 'q@example.com' } }], clock, storageDir: '/x' });
    expect(port).toMatchObject({ ok: false, code: 'INTEGRATION_NOT_CONFIGURED' });
    const demo = resolveEmailTransport({ mode: 'demo', workspaceMode: 'DEMO', integrations: [], clock, storageDir: '/x' });
    expect(demo.ok && demo.value.simulated).toBe(true);
  });

  it('DEMO never gets a live client or a live AI check', () => {
    expect(whatsAppGraphClient({ mode: 'demo', integration: null, graphVersion: 'v24.0', clock })).toMatchObject({ ok: false, code: 'MODE_MISMATCH' });
    expect(aiConnectionCheck({ mode: 'demo', kind: 'AI_ANTHROPIC', apiKey: 'k', modelId: null })).toMatchObject({ ok: false });
    expect(resendApiClient({ mode: 'demo', integration: null, clock })).toMatchObject({ ok: false, code: 'MODE_MISMATCH' });
    expect(smtpConnectionCheck({ mode: 'demo', integration: null, clock })).toMatchObject({ ok: false, code: 'MODE_MISMATCH' });
    // T35: DEMO never gets a Meta Graph or Marketing API client, whatever is stored.
    const integration = { id: 'm1', kind: 'META_ADS' as const, status: 'CONNECTED' as const, config: { pageId: '110000000000001', adAccountId: '510000000000001' }, credentials: creds[0]! };
    const input = { mode: 'demo' as const, integration, graphVersion: 'v24.0', marketingVersion: 'v25.0', clock, usable: CHECKABLE_STATUSES };
    expect(metaLeadsClient(input)).toMatchObject({ ok: false, code: 'MODE_MISMATCH' });
    expect(metaMarketingClient(input)).toMatchObject({ ok: false, code: 'MODE_MISMATCH' });
  });

  it('LIVE Meta clients: only with a readable token, a usable status and the version each API needs (T35)', () => {
    for (const status of IntegrationStatus) {
      for (const credentials of creds) {
        for (const [graphVersion, marketingVersion] of [['v24.0', 'v25.0'], [null, 'v25.0'], ['v24.0', null]] as const) {
          const integration = { id: 'm1', kind: 'META_ADS' as const, status, config: { pageId: '110000000000001', adAccountId: 'act_510000000000001' }, credentials };
          const input = { mode: 'live' as const, integration, graphVersion, marketingVersion, clock, usable: CHECKABLE_STATUSES };
          const leads = metaLeadsClient(input);
          const marketing = metaMarketingClient(input);
          if (leads.ok) expect([CHECKABLE_STATUSES.has(status), credentials.state, graphVersion]).toEqual([true, 'ok', 'v24.0']);
          else expect(['INTEGRATION_NOT_CONFIGURED', 'CREDENTIAL_UNREADABLE']).toContain(leads.code);
          if (marketing.ok) {
            expect([CHECKABLE_STATUSES.has(status), credentials.state, marketingVersion]).toEqual([true, 'ok', 'v25.0']);
            expect(marketing.value.adAccountId).toBe('510000000000001');
          } else expect(['INTEGRATION_NOT_CONFIGURED', 'CREDENTIAL_UNREADABLE']).toContain(marketing.code);
        }
      }
    }
  });

  it('Sheets (T34): DEMO never gets a client; LIVE gets the service account client only when configured', () => {
    expect(sheetsReadClient({ mode: 'demo', integration: null, clock })).toMatchObject({ ok: false, code: 'MODE_MISMATCH' });
    const key = JSON.stringify({ type: 'service_account', client_email: 'reader@proj.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n' });
    const sheetCreds: CredentialState[] = [{ state: 'ok', values: { serviceAccountJson: key } }, { state: 'ok', values: { serviceAccountJson: 'not json' } }, { state: 'missing', fields: ['serviceAccountJson'] }, { state: 'unreadable', field: 'serviceAccountJson' }];
    for (const status of IntegrationStatus) {
      for (const credentials of sheetCreds) {
        const r = sheetsReadClient({ mode: 'live', integration: { id: 'gs_1', kind: 'GOOGLE_SHEETS', status, config: { sheetId: 'x'.repeat(30) }, credentials }, clock });
        if (r.ok) {
          expect(r.value.serviceAccountEmail).toBe('reader@proj.iam.gserviceaccount.com');
          expect(['CONFIGURED_UNVERIFIED', 'VERIFYING', 'CONNECTED', 'DEGRADED', 'ERROR']).toContain(status);
        } else expect(['INTEGRATION_NOT_CONFIGURED', 'CREDENTIAL_UNREADABLE']).toContain(r.code);
      }
    }
  });
});

// Lead-gen suite runtime cases (every status x credential state for a new resolver), each in its slice block.
// ---- lead-gen F1 finder ----
describe('Google Places (ADR-118): LIVE gets the Places client or a typed problem, never the simulated directory', () => {
  const clock = new FixedClock('2026-10-23T06:00:00.000Z');
  const placesCreds: CredentialState[] = [{ state: 'ok', values: { apiKey: 'AIzaSyArchTestKey000000000000000000000' } }, { state: 'ok', values: { apiKey: '  ' } }, { state: 'missing', fields: ['apiKey'] }, { state: 'unreadable', field: 'apiKey' }];
  const use = (status: (typeof IntegrationStatus)[number], credentials: CredentialState): IntegrationUse => ({ id: 'gp_1', kind: 'GOOGLE_PLACES', status, config: {}, credentials });

  it('every status x credential state', () => {
    for (const status of IntegrationStatus) {
      for (const credentials of placesCreds) {
        for (const r of [resolvePlacesProvider({ mode: 'live', workspaceMode: 'LIVE', integration: use(status, credentials), clock }), placesCheckClient({ mode: 'live', integration: use(status, credentials), clock })]) {
          if (r.ok) {
            expect(r.value).toMatchObject({ label: 'google-places', simulated: false });
            expect(CHECKABLE_STATUSES.has(status)).toBe(true);
            expect(credentials.state === 'ok' && credentials.values.apiKey!.trim() !== '').toBe(true);
          } else expect(['INTEGRATION_NOT_CONFIGURED', 'CREDENTIAL_UNREADABLE']).toContain(r.code);
        }
      }
    }
    expect(resolvePlacesProvider({ mode: 'live', workspaceMode: 'LIVE', integration: null, clock })).toMatchObject({ ok: false, code: 'INTEGRATION_NOT_CONFIGURED' });
    expect(resolvePlacesProvider({ mode: 'live', workspaceMode: 'DEMO', integration: null, clock })).toMatchObject({ ok: false, code: 'MODE_MISMATCH' });
    expect(resolvePlacesProvider({ mode: 'live', workspaceMode: 'LIVE', integration: { ...use('CONNECTED', placesCreds[0]!), kind: 'GOOGLE_SHEETS' }, clock })).toMatchObject({ ok: false, code: 'INTEGRATION_NOT_CONFIGURED' });
  });

  it('DEMO gets the simulated directory and never a Places client', () => {
    const demo = resolvePlacesProvider({ mode: 'demo', workspaceMode: 'DEMO', integration: use('CONNECTED', placesCreds[0]!), clock });
    expect(demo.ok && demo.value).toMatchObject({ label: 'demo-places', simulated: true });
    expect(resolvePlacesProvider({ mode: 'demo', workspaceMode: 'LIVE', integration: null, clock })).toMatchObject({ ok: false, code: 'MODE_MISMATCH' });
    expect(placesCheckClient({ mode: 'demo', integration: use('CONNECTED', placesCreds[0]!), clock })).toMatchObject({ ok: false, code: 'MODE_MISMATCH' });
  });
});
// ---- end F1 ----
// ---- lead-gen F2 import ----

// ---- end F2 ----
// ---- lead-gen F3 chat ----

// ---- end F3 ----
// ---- lead-gen F4 templates ----

// ---- end F4 ----
// ---- lead-gen F5 handoff ----

// ---- end F5 ----
// ---- lead-gen F6 presentation ----

// ---- end F6 ----
