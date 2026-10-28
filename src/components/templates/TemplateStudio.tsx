'use client';

/**
 * The template studio page body (ADR-123, slice F4): the editor (new or a draft being edited) and
 * the workspace's templates with their status (icon plus label: Draft, Submitting to Meta, Pending
 * review, Approved, Rejected with Meta's reason, or Meta's raw status), the Simulated chip on the
 * DEMO integration, who wrote the copy, and the actions a template allows: Edit and Delete for a
 * draft, Submit for approval (POST /api/app/templates/[id]/submit), Delete for a template Meta
 * rejected. Gates (plan §12): permission without `templates.manage`; configuration in LIVE without
 * a stored WhatsApp integration (new drafts) or without a verified one with a WABA ID
 * (submission), with the fix link. While a submission waits for Meta (or the DEMO simulated review),
 * the page re-reads itself on the shared worker-wait schedule (usePolling: it skips a hidden tab,
 * backs off, and stops with a "taking longer than usual" line instead of polling forever). Opening
 * the editor (New template, Edit) scrolls it into view and moves focus to it.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, FlaskConical, MessageSquareText, PencilLine, Plus, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { AiProvenance } from '@/components/ai/AiProvenance';
import { StatusChip } from '@/components/integrations/StatusChip';
import { postJson } from '@/components/patterns/api-client';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { ChipTitle } from '@/components/patterns/IconChip';
import { SectionCard } from '@/components/patterns/SectionCard';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { usePolling } from '@/components/leads/use-polling';
import { Button } from '@/components/ui/button';
import { STUDIO_CATEGORY_LABELS, UTILITY_TRIGGER_LABELS, type TemplateDraft, type UtilityTrigger } from '@/lib/domain/template-authoring';
import { formatDateTime } from '@/lib/format/date';
import { templateStatusEntry } from './template-vocabulary';
import { TemplateEditor, type EditorInitial } from './TemplateEditor';

/** The studio read model as the page passes it (services/integrations/template-authoring.ts, dates as ISO strings). */
export type StudioTemplate = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  origin: 'SYNCED' | 'AUTHORED';
  rejectedReason: string | null;
  utilityTrigger: string | null;
  copyGeneratorLabel: string | null;
  submittedAt: string | null;
  syncedAt: string | null;
  simulated: boolean;
  body: string;
  notSendable: string | null;
  editable: boolean;
  submittable: boolean;
  deletable: boolean;
  draft: TemplateDraft | null;
  lastSubmit: { result: string; outcome: string | null; errorCode: string | null; message: string | null; at: string } | null;
};

export type StudioView = {
  workspace: { name: string; timezone: string };
  mode: 'demo' | 'live';
  canManage: boolean;
  whatsapp: { canDraft: boolean; canSubmit: boolean; problem: string | null };
  ai: { local: boolean; available: boolean };
  templates: StudioTemplate[];
  media: Array<{ id: string; fileName: string; byteSize: number }>;
};

const PERMISSION: Gate = { category: 'permission', reason: 'Your assignment here does not include “Manage templates”. A super admin can grant it.' };

function snippet(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 160 ? `${one.slice(0, 157)}...` : one;
}

export function TemplateStudio({ workspaceSlug, view }: { workspaceSlug: string; view: StudioView }) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const [editing, setEditing] = useState<EditorInitial | null>(null);
  const setupHref = `/dashboard/employee/${encodeURIComponent(workspaceSlug)}/integrations/whatsapp`;
  const integrationsHref = `/dashboard/employee/${encodeURIComponent(workspaceSlug)}/integrations`;

  const newGate: Gate | null = !view.canManage
    ? PERMISSION
    : !view.whatsapp.canDraft
      ? { category: 'configuration', reason: view.whatsapp.problem ?? 'Set up WhatsApp first.', fix: { href: setupHref, label: 'Open WhatsApp setup' } }
      : null;
  const submitGate: Gate | null = !view.canManage
    ? PERMISSION
    : !view.whatsapp.canSubmit
      ? { category: 'configuration', reason: view.whatsapp.problem ?? 'Connect and verify WhatsApp first.', fix: { href: setupHref, label: 'Open WhatsApp setup' } }
      : null;
  const aiGate: Gate | null = view.ai.available
    ? null
    : { category: 'configuration', reason: 'Connect an AI integration (Anthropic or OpenAI) to generate copy, or write the template yourself.', fix: { href: integrationsHref, label: 'Open integrations' } };

  const waiting = view.templates.some((t) => t.status.trim().toUpperCase() === 'SUBMITTING' || (view.mode === 'demo' && t.origin === 'AUTHORED' && t.status.trim().toUpperCase() === 'PENDING'));
  const { exhausted } = usePolling(waiting, () => router.refresh());
  const editorRef = useRef<HTMLDivElement>(null);
  const editingKey = editing ? (editing.id ?? 'new') : null;
  useEffect(() => {
    if (editingKey === null) return;
    // The editor opens above the list: bring it into view and give keyboard and screen-reader users a place.
    const el = editorRef.current;
    el?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    el?.focus({ preventScroll: true });
  }, [editingKey]);

  async function submit(t: StudioTemplate) {
    const res = await postJson<{ simulated: boolean; template: { status: string } }>(`/api/app/templates/${encodeURIComponent(t.id)}/submit`, { workspaceSlug }, csrf);
    if (!res.ok) {
      toast.error('Not submitted', { description: `${res.message}${res.reference ? ` Reference ${res.reference}.` : ''}` });
      return;
    }
    toast.success(res.data.simulated ? 'Submitted to the simulated review' : 'Submitting to Meta', {
      description: res.data.simulated ? 'Simulated: the demo review answers in about 30 seconds. No provider contacted.' : 'Meta reviews new templates, usually within minutes. This page updates by itself.',
    });
    router.refresh();
  }

  async function remove(t: StudioTemplate) {
    const res = await postJson(`/api/app/templates/${encodeURIComponent(t.id)}/delete`, { workspaceSlug }, csrf);
    if (!res.ok) return { ok: false as const, message: res.message, reference: res.reference };
    toast.success('Template deleted', { description: t.name });
    if (editing?.id === t.id) setEditing(null);
    router.refresh();
    return { ok: true as const };
  }

  const authored = view.templates.filter((t) => t.origin === 'AUTHORED');
  const synced = view.templates.filter((t) => t.origin === 'SYNCED');

  return (
    <div className="flex flex-col gap-6">
      {view.mode === 'demo' ? (
        <p className="flex items-start gap-2 rounded-lg border border-demo/35 bg-demo/8 px-3 py-2 text-sm text-fg-1">
          <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-demo" />
          Simulated: submissions go to a demo review that approves after about 30 seconds (names containing “reject” are rejected). Meta is never contacted.
        </p>
      ) : null}

      {exhausted ? (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-warning/35 bg-warning/8 px-3 py-2 text-sm text-fg-1">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
          {view.mode === 'demo' ? 'The simulated review is taking longer than usual: the worker may not be running. Reload this page later.' : 'Meta is taking longer than usual to answer. This page stopped checking; reload it later or run a template sync.'}
        </p>
      ) : null}

      {editing ? (
        <div ref={editorRef} tabIndex={-1} role="region" aria-label="Template editor" className="scroll-mt-4">
          <TemplateEditor
            key={editing.id ?? 'new'}
            workspaceSlug={workspaceSlug}
            businessName={view.workspace.name}
            localGenerator={view.ai.local}
            aiGate={aiGate}
            initial={editing}
            media={view.media}
            onClose={() => setEditing(null)}
          />
        </div>
      ) : null}

      <SectionCard
        title={
          <ChipTitle icon={<MessageSquareText aria-hidden="true" />} hue="zest">
            Your templates
          </ChipTitle>
        }
        meta="Written here and submitted to Meta. Only an approved template can start a WhatsApp conversation; every send still needs the customer's opt-in."
        actions={
          newGate ? (
            <GatedAction label="New template" size="sm" gate={newGate} />
          ) : (
            <Button size="sm" onClick={() => setEditing({ id: null, draft: null, copyGeneratorLabel: null })}>
              <Plus aria-hidden="true" />
              New template
            </Button>
          )
        }
      >
        {view.mode === 'live' && view.whatsapp.problem && view.whatsapp.canDraft ? (
          <p role="note" className="flex items-start gap-2 rounded-lg border border-warning/35 bg-warning/8 px-3 py-2 text-sm text-fg-1">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            {view.whatsapp.problem}
          </p>
        ) : null}
        {authored.length === 0 ? (
          <p className="text-sm text-fg-2">No templates written here yet. Choose New template: pick the category, then write or generate the copy.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {authored.map((t) => {
              const status = t.status.trim().toUpperCase();
              const failed = status === 'DRAFT' && t.lastSubmit && t.lastSubmit.result !== 'SUCCESS' ? t.lastSubmit : null;
              return (
                <li key={t.id} data-template={t.name} className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-bg-2/40 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm break-all text-fg-1">{t.name}</span>
                    <span className="text-xs text-fg-2">
                      ({t.language}) {STUDIO_CATEGORY_LABELS[t.category.toUpperCase() as 'MARKETING' | 'UTILITY']?.label ?? t.category}
                    </span>
                    <StatusChip entry={templateStatusEntry(t.status)} title={`Status: ${t.status}`} />
                    {t.simulated ? <ModeChip simulated /> : null}
                    {t.copyGeneratorLabel ? <AiProvenance generatorLabel={t.copyGeneratorLabel} /> : null}
                  </div>
                  {t.utilityTrigger ? <p className="text-xs text-fg-2">Sent when: {UTILITY_TRIGGER_LABELS[t.utilityTrigger as UtilityTrigger] ?? t.utilityTrigger}</p> : null}
                  <p className="text-sm text-fg-2">{snippet(t.body) || 'No body yet.'}</p>
                  {status === 'REJECTED' ? (
                    <p role="note" data-rejected-reason className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-fg-1">
                      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
                      {t.rejectedReason ? `Meta's reason: ${t.rejectedReason}` : 'Meta rejected this template without a reason in the last sync.'}
                    </p>
                  ) : null}
                  {status === 'SUBMITTING' ? <p className="text-xs text-fg-2">{exhausted ? 'Still waiting for Meta’s answer.' : 'Waiting for Meta’s answer. This page updates by itself.'}</p> : null}
                  {status === 'PENDING' && t.simulated ? <p className="text-xs text-fg-2">Simulated review in progress: the demo answers about 30 seconds after the submission.{exhausted ? '' : ' This page updates by itself.'}</p> : null}
                  {failed?.message ? (
                    <p role="note" className="flex items-start gap-2 text-xs text-fg-1">
                      <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0 text-danger" />
                      Last submission ({formatDateTime(new Date(failed.at), view.workspace.timezone)}): {failed.message}
                    </p>
                  ) : null}
                  {t.notSendable && status !== 'DRAFT' ? <p className="text-xs text-warning">Not sendable from here: {t.notSendable}.</p> : null}
                  <div className="flex flex-wrap items-start gap-2">
                    {t.editable && view.canManage ? (
                      <Button variant="secondary" size="sm" onClick={() => setEditing({ id: t.id, draft: t.draft, copyGeneratorLabel: t.copyGeneratorLabel })}>
                        <PencilLine aria-hidden="true" />
                        Edit
                      </Button>
                    ) : null}
                    {t.submittable ? (
                      submitGate ? (
                        <GatedAction label="Submit for approval" size="sm" gate={submitGate} />
                      ) : (
                        <GatedAction label="Submit for approval" pendingLabel="Submitting..." size="sm" icon={<Send aria-hidden="true" />} gate={null} onAction={() => submit(t)} />
                      )
                    ) : null}
                    {t.deletable && view.canManage ? (
                      <ConfirmDialog
                        trigger={
                          <Button variant="ghost" size="sm">
                            <Trash2 aria-hidden="true" />
                            Delete
                          </Button>
                        }
                        title={`Delete ${t.name}?`}
                        description={status === 'DRAFT' ? 'The draft is removed. Nothing was sent to Meta.' : view.mode === 'live' ? 'The rejected template is deleted in WhatsApp Manager and here. Meta keeps its name reserved for a while.' : 'The rejected template is removed (simulated: nothing is contacted).'}
                        confirmLabel="Delete template"
                        pendingLabel="Deleting..."
                        workspaceName={view.workspace.name}
                        destructive
                        onConfirm={() => remove(t)}
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      {synced.length > 0 ? (
        <SectionCard title="Synced from WhatsApp Manager" meta="Templates created in WhatsApp Manager. Map their variables and buttons on the WhatsApp setup page.">
          <ul className="flex flex-col gap-2">
            {synced.map((t) => (
              <li key={t.id} data-template={t.name} className="flex flex-wrap items-center gap-2 rounded-lg border border-border-subtle bg-bg-2/40 px-3 py-2">
                <span className="font-mono text-sm break-all text-fg-1">{t.name}</span>
                <span className="text-xs text-fg-2">
                  ({t.language}) {t.category}
                </span>
                <StatusChip entry={templateStatusEntry(t.status)} title={`Status: ${t.status}`} />
                {t.simulated ? <ModeChip simulated /> : null}
                {t.status.trim().toUpperCase() === 'REJECTED' && t.rejectedReason ? <span className="text-xs text-fg-2">Meta’s reason: {t.rejectedReason}</span> : null}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}
