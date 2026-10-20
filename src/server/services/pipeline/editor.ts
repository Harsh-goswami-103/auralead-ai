/**
 * Pipeline editor read model and dry run (T28; PRD "React Flow pipeline (small validated stage set:
 * ingestion, score, draft, approval, delivery; persisted; rejects cycles/unsupported; executed)";
 * 06-design §11.2.2 "Pipeline: canvas, validation panel, persisted versions and execution status per
 * stage", §11.3 "Saved but a stage's integration not configured: node shows status").
 *
 * - `getPipelineEditor(ctx)` (`leads.read`): the active version's graph (normalized to the
 *   validator's shape), every version with who created it, PipelineStageRun counts per stage and
 *   status for this workspace, what the DRAFT and DELIVERY stages run on right now (DEMO: the local
 *   generator and demo transports; LIVE: the AI and messaging integrations' stored status), the
 *   workspace auto-send switch (POLICY_AUTO needs it, P11) and `canEdit` (`pipeline.manage`).
 * - `validatePipelineDraft(ctx, input)` (`pipeline.manage`): T23's validator with the workspace's
 *   auto-send setting; writes nothing. Saving is T23's `savePipelineConfig` (validator again, CAS on
 *   the version the editor saw, version N+1 active, audited), so the editor cannot persist a graph
 *   the executor would not run.
 */
import type { PipelineApprovalMode, PipelineStage } from '@/lib/domain/enums';
import { PipelineStage as PIPELINE_STAGES } from '@/lib/domain/enums';
import { NotFoundError } from '@/lib/errors';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { USABLE_AI_STATUSES } from '@/server/adapters/ai/registry';
import { validatePipelineConfig, type PipelineGraph, type PipelineIssue } from './validator';

export type StageStats = { done: number; pending: number; running: number; skipped: number; failed: number };

export type StageReadiness = { label: string; tone: 'success' | 'warning' | 'demo' | 'neutral' };

export type EditorVersion = {
  id: string;
  version: number;
  approvalMode: PipelineApprovalMode;
  active: boolean;
  stages: PipelineStage[];
  createdAt: Date;
  createdByName: string | null;
};

export type PipelineEditorView = {
  mode: 'demo' | 'live';
  workspace: { slug: string; name: string; timezone: string };
  canEdit: boolean;
  autoSendEnabled: boolean;
  active: { id: string; version: number; approvalMode: PipelineApprovalMode; graph: PipelineGraph } | null;
  versions: EditorVersion[];
  stats: Record<PipelineStage, StageStats>;
  readiness: Record<PipelineStage, StageReadiness | null>;
};

export type PipelineDraftResult = { ok: true; order: PipelineStage[]; issues: [] } | { ok: false; issues: PipelineIssue[] };

const isStage = (value: unknown): value is PipelineStage => typeof value === 'string' && (PIPELINE_STAGES as readonly string[]).includes(value);

/** A stored graph in the editor's shape; stages of unknown kinds are left out (the validator would reject them). */
function normalizeGraph(graph: unknown): PipelineGraph {
  const g = (typeof graph === 'object' && graph !== null ? graph : {}) as { stages?: unknown; edges?: unknown };
  const stages = (Array.isArray(g.stages) ? g.stages : [])
    .map((s) => (typeof s === 'object' && s !== null ? (s as { id?: unknown; kind?: unknown; label?: unknown }) : {}))
    .filter((s): s is { id: string; kind: PipelineStage; label?: unknown } => typeof s.id === 'string' && isStage(s.kind))
    .map((s) => ({ id: s.id, kind: s.kind, label: typeof s.label === 'string' ? s.label : s.kind }));
  const ids = new Set(stages.map((s) => s.id));
  const edges = (Array.isArray(g.edges) ? g.edges : [])
    .map((e) => (typeof e === 'object' && e !== null ? (e as { from?: unknown; to?: unknown }) : {}))
    .filter((e): e is { from: string; to: string } => typeof e.from === 'string' && typeof e.to === 'string' && ids.has(e.from) && ids.has(e.to))
    .map((e) => ({ from: e.from, to: e.to }));
  return { schemaVersion: 1, stages, edges };
}

const emptyStats = (): StageStats => ({ done: 0, pending: 0, running: 0, skipped: 0, failed: 0 });

const STATUS_KEY: Readonly<Record<string, keyof StageStats>> = { DONE: 'done', PENDING: 'pending', RUNNING: 'running', SKIPPED: 'skipped', FAILED: 'failed' };

async function readiness(ctx: AppCtx): Promise<Record<PipelineStage, StageReadiness | null>> {
  const base: Record<PipelineStage, StageReadiness | null> = { INGESTION: null, SCORE: null, DRAFT: null, APPROVAL: null, DELIVERY: null };
  if (ctx.mode === 'demo') {
    return { ...base, DRAFT: { label: 'Local generator (DEMO)', tone: 'demo' }, DELIVERY: { label: 'Demo transports, no provider contacted', tone: 'demo' } };
  }
  const rows = await ctx.db.integration.findMany({ select: { kind: true, status: true } });
  const ai = rows.find((r) => (r.kind === 'AI_ANTHROPIC' || r.kind === 'AI_OPENAI') && USABLE_AI_STATUSES.has(r.status));
  const messaging = rows.filter((r) => (r.kind === 'WHATSAPP_CLOUD' || r.kind === 'EMAIL_RESEND' || r.kind === 'EMAIL_SMTP') && r.status === 'CONNECTED');
  return {
    ...base,
    DRAFT: ai ? { label: ai.kind === 'AI_ANTHROPIC' ? 'AI: Anthropic' : 'AI: OpenAI', tone: 'success' } : { label: 'No AI provider set up: drafts go to review', tone: 'warning' },
    DELIVERY:
      messaging.length > 0
        ? { label: `Sends through ${messaging.map((m) => (m.kind === 'WHATSAPP_CLOUD' ? 'WhatsApp' : 'email')).join(' and ')}`, tone: 'success' }
        : { label: 'No messaging integration connected: nothing is sent', tone: 'warning' },
  };
}

export async function getPipelineEditor(ctx: AppCtx): Promise<PipelineEditorView> {
  requireCapability(ctx, 'leads.read');
  const workspaceId = requireWorkspace(ctx);
  const workspace = await ctx.db.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true, name: true, timezone: true } });
  if (!workspace) throw new NotFoundError();
  const versions = await ctx.db.pipelineConfigVersion.findMany({ orderBy: { version: 'desc' } });
  const settings = await ctx.db.workspaceSettings.findFirst({ select: { autoSendEnabled: true } });
  const creators = await ctx.db.user.findMany({ where: { id: { in: [...new Set(versions.map((v) => v.createdBy))] } }, select: { id: true, name: true } });
  const nameOf = new Map(creators.map((u) => [u.id, u.name]));
  const groups = await ctx.db.pipelineStageRun.groupBy({ by: ['stage', 'status'], _count: { _all: true } });

  const stats = Object.fromEntries(PIPELINE_STAGES.map((s) => [s, emptyStats()])) as Record<PipelineStage, StageStats>;
  for (const g of groups) {
    const key = STATUS_KEY[g.status];
    if (key && isStage(g.stage)) stats[g.stage][key] += g._count._all;
  }
  const active = versions.find((v) => v.active) ?? null;
  return {
    mode: ctx.mode,
    workspace,
    canEdit: hasCapability(ctx, 'pipeline.manage'),
    autoSendEnabled: settings?.autoSendEnabled ?? false,
    active: active ? { id: active.id, version: active.version, approvalMode: active.approvalMode, graph: normalizeGraph(active.graph) } : null,
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      approvalMode: v.approvalMode,
      active: v.active,
      stages: normalizeGraph(v.graph).stages.map((s) => s.kind),
      createdAt: v.createdAt,
      createdByName: nameOf.get(v.createdBy) ?? null,
    })),
    stats,
    readiness: await readiness(ctx),
  };
}

export async function validatePipelineDraft(ctx: AppCtx, input: { graph: unknown; approvalMode: unknown }): Promise<PipelineDraftResult> {
  requireCapability(ctx, 'pipeline.manage');
  const settings = await ctx.db.workspaceSettings.findFirst({ select: { autoSendEnabled: true } });
  const result = validatePipelineConfig({ graph: input.graph, approvalMode: input.approvalMode }, { autoSendEnabled: settings?.autoSendEnabled ?? false });
  return result.ok ? { ok: true, order: result.order, issues: [] } : { ok: false, issues: result.issues };
}
