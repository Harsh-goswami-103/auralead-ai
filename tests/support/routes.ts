/**
 * Route harness for the route manifest (plan §3 routes.manifest.ts): discovers every App Router
 * `page.tsx` and `route.ts` on disk, maps a file to its URL pattern, reads the HTTP methods a
 * route module exports, resolves manifest fixture references against the deterministic seed,
 * and invokes API handlers and page modules (with their layouts) in-process so the tenant matrix
 * runs the real code paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { DEMO_PERSONAS } from '@/server/auth/demo-personas';
import type { FixtureValue, HttpMethod, MatrixActor, RouteEntry } from '@/server/routes.manifest';
import { USER_FIXTURES } from '../../prisma/seed/fixtures/identities';
import { seedId } from '../../prisma/seed/ids';
import { REPO_ROOT } from './spawn';

export const APP_DIR = path.join(REPO_ROOT, 'src', 'app');
export const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const toPosix = (p: string) => p.split(path.sep).join('/');

/** Repo-relative POSIX paths of every page.tsx and route.ts under src/app (private `_dirs` skipped). */
export function discoverRouteFiles(dir = APP_DIR): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('_')) out.push(...discoverRouteFiles(full));
    } else if (/^(page\.tsx|route\.ts)$/.test(entry.name)) {
      out.push(toPosix(path.relative(REPO_ROOT, full)));
    }
  }
  return out.sort();
}

export function kindOfFile(file: string): 'page' | 'api' {
  return file.endsWith('/page.tsx') ? 'page' : 'api';
}

/** `src/app/(auth)/invite/[token]/page.tsx` -> `/invite/[token]`; route groups vanish. */
export function routePathFromFile(file: string): string {
  const segments = file
    .replace(/^src\/app\//, '')
    .split('/')
    .slice(0, -1)
    .filter((s) => !(s.startsWith('(') && s.endsWith(')')));
  return `/${segments.join('/')}`;
}

/** Dynamic segment names in a route pattern (`[ws]`, `[...slug]`, `[[...slug]]`). */
export function dynamicSegments(routePath: string): string[] {
  return [...routePath.matchAll(/\[\[?(?:\.\.\.)?([^\]]+)\]\]?/g)].map((m) => m[1]!);
}

/** HTTP method handlers a route module exports (`export const GET`, `export async function POST`, `export { x as PUT }`). */
export function exportedMethods(file: string): HttpMethod[] {
  const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = new Set<string>();
  const exported = (node: ts.Node) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const stmt of source.statements) {
    if (ts.isVariableStatement(stmt) && exported(stmt)) {
      for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name)) found.add(d.name.text);
    } else if (ts.isFunctionDeclaration(stmt) && exported(stmt) && stmt.name) {
      found.add(stmt.name.text);
    } else if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) found.add(el.name.text);
    }
  }
  return HTTP_METHODS.filter((m) => found.has(m));
}

/** Layout files that wrap a page, outermost first. The root layout (fonts, html shell) has no gate and is skipped. */
export function layoutChain(file: string): string[] {
  const dirs = file.split('/').slice(0, -1);
  const chain: string[] = [];
  for (let i = 3; i <= dirs.length; i++) {
    const candidate = `${dirs.slice(0, i).join('/')}/layout.tsx`;
    if (fs.existsSync(path.join(REPO_ROOT, candidate))) chain.push(candidate);
  }
  return chain;
}

// ---- Fixtures --------------------------------------------------------------------------------

/** Workspace A belongs to the owner persona; workspace B is another tenant (the narrow employee's). */
export const WORKSPACE_A = 'smile-avenue-dental';
export const WORKSPACE_B = 'ironpulse-fitness';

/** The seeded user behind each matrix actor (null: no session). */
export const MATRIX_ACTOR_USERS: Record<MatrixActor, string | null> = {
  anonymous: null,
  ownerA: 'owner',
  employeeUnassigned: 'arjun',
  employeeNoCapability: 'neha',
  superAdmin: 'admin',
};

const emailOf = (key: string) => USER_FIXTURES.find((u) => u.key === key)!.email;

/** Every fixture key a manifest entry may reference, resolved from the deterministic seed. */
export const MATRIX_FIXTURES: Readonly<Record<string, string>> = {
  'workspaceA.id': seedId('workspace', WORKSPACE_A),
  'workspaceA.slug': WORKSPACE_A,
  'workspaceB.id': seedId('workspace', WORKSPACE_B),
  'workspaceB.slug': WORKSPACE_B,
  'workspaceB.ownerEmail': emailOf('rohan'),
  'workspaceB.ownerUserId': seedId('user', 'rohan'),
  'persona.user': 'user',
  'persona.owner.email': DEMO_PERSONAS.user.email,
  /** Well-formed (43-char base64url) but never issued. */
  'invite.unknownToken': Buffer.alloc(32, 0x5a).toString('base64url'),
  'password.wrong': 'not-the-password-123',
  /** T13: a priced service of workspace B. */
  'workspaceB.serviceId': seedId('service', `${WORKSPACE_B}:PT-12`),
  /** T15: workspace B's seeded lead and DRAFT quote (prisma/seed/fixtures/quotes.ts). */
  'workspaceB.leadId': seedId('lead', `${WORKSPACE_B}:Q-0001`),
  'workspaceB.quoteId': seedId('quote', `${WORKSPACE_B}:Q-0001`),
  /** T16: a well-formed quote share token that was never issued. */
  'share.unknownToken': Buffer.alloc(32, 0x51).toString('base64url'),
  /** T23: a well-formed bulk run id that does not exist. */
  'bulk.unknownRunId': 'bulkrunmatrixprobe0000000',
  /** T24: well-formed job and webhook event ids that do not exist. */
  'admin.unknownJobId': 'jobmatrixprobe00000000000',
  'admin.unknownEventId': 'eventmatrixprobe000000000',
  /** T22: workspace B's seeded PENDING approval of quote Q-0001 v1, and a conversation id that does not exist. */
  'workspaceB.approvalId': seedId('approval', `${WORKSPACE_B}:Q-0001:1`),
  'inbox.unknownConversationId': 'convmatrixprobe0000000000',
  /** T29: the seeded super admin (self-change probes), the narrow employee, and an invite id that does not exist. */
  'admin.userId': seedId('user', 'admin'),
  'employeeNoCapability.userId': seedId('user', 'neha'),
  'admin.unknownInviteId': 'invitematrixprobe00000000',
  /** T26: a well-formed lead export id that does not exist. */
  'leads.unknownExportId': 'exportmatrixprobe00000000',
  /** T36: a well-formed extension token id that does not exist. */
  'extension.unknownTokenId': 'exttokenmatrixprobe000000',
  // Lead-gen suite fixture keys: well-formed unknown-id probes, never seeded rows; each in its slice's block.
  // ---- lead-gen F1 finder ----
  /** F1 (ADR-118): well-formed finder run, finder result and lead ids that do not exist. */
  'finder.unknownRunId': 'finderrunmatrixprobe00000',
  'finder.unknownResultId': 'finderresultmatrixprobe00',
  'finder.unknownLeadId': 'finderleadmatrixprobe0000',
  // ---- end F1 ----
  // ---- lead-gen F2 import ----
  /** T41: a well-formed lead import id that does not exist. */
  'imports.unknownImportId': 'importmatrixprobe00000000',
  // ---- end F2 ----
  // ---- lead-gen F3 chat ----

  // ---- end F3 ----
  // ---- lead-gen F4 templates ----

  // ---- end F4 ----
  // ---- lead-gen F5 handoff ----
  /** T44: a well-formed lead handoff id that does not exist. */
  'handoffs.unknownId': 'handoffmatrixprobe0000000',
  // ---- end F5 ----
  // ---- lead-gen F6 presentation ----

  // ---- end F6 ----
};

export function resolveFixtures<T extends FixtureValue | undefined>(value: T): unknown {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => resolveFixtures(v));
  if (typeof value === 'object') {
    if ('$fixture' in value && typeof value.$fixture === 'string') {
      const resolved = MATRIX_FIXTURES[value.$fixture];
      if (resolved === undefined) throw new Error(`unknown manifest fixture "${value.$fixture}"`);
      return resolved;
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveFixtures(v as FixtureValue)]));
  }
  return value;
}

/** Every `$fixture` key used in a value. */
export function fixtureKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) fixtureKeys(v, out);
  else if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (typeof rec.$fixture === 'string') out.push(rec.$fixture);
    else for (const v of Object.values(rec)) fixtureKeys(v, out);
  }
  return out;
}

export function fillPath(routePath: string, params: Record<string, string>): string {
  return routePath.replace(/\[\[?(?:\.\.\.)?([^\]]+)\]\]?/g, (_, name: string) => encodeURIComponent(params[name] ?? ''));
}

export function resolvedParams(entry: RouteEntry): Record<string, string> {
  return (resolveFixtures(entry.params ?? {}) ?? {}) as Record<string, string>;
}

// ---- Module loading --------------------------------------------------------------------------

/** Imports an app module by repo-relative path through the test runner (so `@/` aliases and JSX resolve). */
export async function loadAppModule(file: string): Promise<Record<string, unknown>> {
  const abs = path.join(REPO_ROOT, file);
  if (!fs.existsSync(abs)) throw new Error(`app module not found: ${file}`);
  return (await import(/* @vite-ignore */ toPosix(abs))) as Record<string, unknown>;
}

export type InvokeResult = { status: number; location?: string; body?: unknown };

type NextControlError = { digest?: unknown };

/** Maps Next's control-flow errors (redirect, notFound) to the HTTP status Next would send. */
export function statusFromNextError(error: unknown): InvokeResult | null {
  const digest = (error as NextControlError | null)?.digest;
  if (typeof digest !== 'string') return null;
  if (digest.startsWith('NEXT_REDIRECT')) {
    const [, , location, status] = digest.split(';');
    return { status: Number(status ?? 307), location };
  }
  const m = /^NEXT_HTTP_ERROR_FALLBACK;(\d{3})$/.exec(digest);
  return m ? { status: Number(m[1]) } : null;
}

/** Runs a page's layouts (outermost first) then the page itself, as Next does for one request. */
export async function invokePage(file: string, params: Record<string, string>): Promise<InvokeResult> {
  const props = { params: Promise.resolve(params), searchParams: Promise.resolve({}) };
  try {
    for (const layoutFile of layoutChain(file)) {
      const layout = (await loadAppModule(layoutFile)).default as (p: unknown) => unknown;
      await layout({ children: null, params: props.params });
    }
    const page = (await loadAppModule(file)).default as (p: unknown) => unknown;
    await page(props);
    return { status: 200 };
  } catch (error) {
    const mapped = statusFromNextError(error);
    if (mapped) return mapped;
    throw error;
  }
}

type Handler = (req: Request, segment: { params: Promise<Record<string, string>> }) => Promise<Response>;

export async function invokeApi(file: string, method: HttpMethod, req: Request, params: Record<string, string>): Promise<InvokeResult & { response: Response }> {
  const mod = await loadAppModule(file);
  const handler = mod[method] as Handler | undefined;
  if (typeof handler !== 'function') throw new Error(`${file} does not export ${method}`);
  const response = await handler(req, { params: Promise.resolve(params) });
  const text = await response.clone().text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body kept as text
  }
  return { status: response.status, body, response };
}
