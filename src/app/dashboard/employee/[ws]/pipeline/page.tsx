/**
 * Pipeline for one workspace (T28; PRD "React Flow pipeline (small validated stage set: ingestion,
 * score, draft, approval, delivery; persisted; rejects cycles/unsupported; executed)"; 06-design
 * §11.2.2 "Pipeline: canvas, validation panel, persisted versions and execution status per stage").
 * The `[ws]` slug is resolved against the employee's active assignments (404 otherwise); reading
 * needs `leads.read`, editing `pipeline.manage`. The editor validates every change on the server
 * and saves version N+1 through T23's validator; leads keep the version they were pinned to (O5).
 * A workspace without an active pipeline starts from the default five-stage template.
 */
import type { Metadata } from 'next';
import { Activity, History, Workflow } from 'lucide-react';
import { NotInAssignment } from '@/components/integrations/NotInAssignment';
import { WorkspaceSectionNav } from '@/components/integrations/WorkspaceSectionNav';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ChipTitle } from '@/components/patterns/IconChip';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { PipelineEditor } from '@/components/pipeline/PipelineEditor';
import { StageStatsTable, VersionHistory } from '@/components/pipeline/PipelineFacts';
import { APPROVAL_MODE_LABELS, defaultGraph } from '@/components/pipeline/pipeline-model';
import { formatDateTime } from '@/lib/format/date';
import { getPipelineEditor } from '@/server/services/pipeline/editor';
import { readOrNull, workspacePage } from '../integrations/_lib/workspace-page';

export const metadata: Metadata = { title: 'Pipeline' };
export const dynamic = 'force-dynamic';

export default async function PipelinePage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const page = await workspacePage(ws);
  const view = await readOrNull(() => getPipelineEditor(page.ctx));
  const name = view?.workspace.name ?? ws;
  const active = view?.active ?? null;
  const activeRow = view?.versions.find((v) => v.active) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={name}
        title="Pipeline"
        description="Every new lead runs these stages in order, on the version that was active when it arrived. Approval is mandatory: nothing reaches a customer without it, and every send is checked again at dispatch."
        meta={
          active && activeRow
            ? `Active: v${active.version}, ${APPROVAL_MODE_LABELS[active.approvalMode].toLowerCase()}, saved ${formatDateTime(activeRow.createdAt, view!.workspace.timezone)}`
            : undefined
        }
      />
      <WorkspaceSectionNav slug={ws} workspaceName={name} />
      {view === null ? (
        <NotInAssignment what="The pipeline" />
      ) : (
        <>
          <SectionCard
            title={
              <ChipTitle icon={<Workflow aria-hidden="true" />} hue="zest">
                Stages
              </ChipTitle>
            }
            meta={
              active
                ? 'The five allowed stages. Score, Draft and Delivery are optional; Ingestion and Approval are required.'
                : 'No pipeline is active, so new leads are stored but not run. Save the default template below to start.'
            }
          >
            <PipelineEditor
              workspaceSlug={ws}
              canEdit={view.canEdit}
              autoSendEnabled={view.autoSendEnabled}
              baseVersion={active?.version ?? 0}
              initialGraph={active ? { stages: active.graph.stages, edges: active.graph.edges } : defaultGraph()}
              initialApprovalMode={active?.approvalMode ?? 'HUMAN'}
              readiness={view.readiness}
            />
          </SectionCard>

          <div className="grid gap-4 xl:grid-cols-2">
            <SectionCard
              title={
                <ChipTitle icon={<Activity aria-hidden="true" />} hue="aura">
                  Execution status per stage
                </ChipTitle>
              }
              meta="Stage runs of this workspace’s leads, across every version."
            >
              <StageStatsTable stats={view.stats} />
            </SectionCard>
            <SectionCard
              title={
                <ChipTitle icon={<History aria-hidden="true" />} hue="ice">
                  Versions
                </ChipTitle>
              }
              meta="Saved versions are never edited. Leads keep the version they were pinned to."
            >
              {view.versions.length === 0 ? (
                <EmptyState headingLevel="h3" icon={<History aria-hidden="true" className="size-5" />} title="No versions saved" description="The first save creates version 1 and makes it active." />
              ) : (
                <VersionHistory versions={view.versions} timeZone={view.workspace.timezone} />
              )}
            </SectionCard>
          </div>
        </>
      )}
    </div>
  );
}
