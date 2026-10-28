'use client';

/**
 * Bulk send from the operator console's lead table (PRD employee console "bulk selection +
 * eligible/skipped counts", T23 backend and drawer, wired by T26). The operator selects rows, opens
 * "Bulk send", chooses an email or an approved WhatsApp template, and checks eligibility first: the
 * server's pre-flight runs the same eligibility function dispatch uses (sendIntent BULK) and answers
 * eligible, skipped and failed counts with the reasons. Confirming queues only the eligible rows as
 * one bulk run (one request key per dialog, so a double click is one run); the result drawer
 * (BulkResultSummary) reads the persisted run and follows it until every row has a result.
 * Nothing is sent from the browser and no count is computed here.
 */
import { useId, useRef, useState } from 'react';
import { CircleCheck, CircleSlash, CircleX, Send, ShieldCheck } from 'lucide-react';
import { postAction, newRequestKey } from '@/components/inbox/api';
import { BulkResultSummary } from '@/components/patterns/BulkResultSummary';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, GateReason, type Gate } from '@/components/patterns/GatedAction';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import type { BulkPreflightDto, BulkRunDto } from '@/lib/schemas/bulk';
import { ToneChip } from './ToneChip';
import { usePolling } from './use-polling';

export type BulkTemplateOption = { id: string; name: string; language: string };

type Channel = 'SEND_EMAIL' | 'SEND_WHATSAPP_TEMPLATE';

/** Positional template values ("1", "2", ...) from one value per line. */
export function templateVariables(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 20)
    .forEach((v, i) => {
      out[String(i + 1)] = v;
    });
  return out;
}

export function BulkSendPanel(props: {
  workspaceSlug: string;
  workspaceName: string;
  selectedIds: string[];
  templates: BulkTemplateOption[];
  /** Null when the viewer may confirm bulk sends (dispatch.send and approvals.decide). */
  sendGate: Gate | null;
  onClear: () => void;
  onSelectRows: (ids: string[]) => void;
}) {
  const csrfToken = useCsrfToken();
  const ids = { channel: useId(), subject: useId(), body: useId(), template: useId(), vars: useId(), gate: useId() };
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<Channel>('SEND_EMAIL');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [templateId, setTemplateId] = useState(props.templates[0]?.id ?? '');
  const [variables, setVariables] = useState('');
  const [preflight, setPreflight] = useState<BulkPreflightDto | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [run, setRun] = useState<BulkRunDto | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const requestKey = useRef<string | null>(null);
  const count = props.selectedIds.length;

  const templateGate: Gate | null =
    channel === 'SEND_WHATSAPP_TEMPLATE' && props.templates.length === 0
      ? {
          category: 'configuration',
          reason: 'No approved WhatsApp template is available for this workspace. Write and submit one in the template studio, or sync one from WhatsApp Manager.',
          fix: { href: `/dashboard/employee/${props.workspaceSlug}/templates`, label: 'Open templates' },
        }
      : null;

  function action() {
    const leadIds = props.selectedIds;
    return channel === 'SEND_EMAIL'
      ? { action: 'SEND_EMAIL' as const, subject: subject.trim(), body: body.trim(), leadIds }
      : { action: 'SEND_WHATSAPP_TEMPLATE' as const, templateId, variables: templateVariables(variables), leadIds };
  }

  function edited() {
    setPreflight(null);
    setFailure(null);
  }

  async function check() {
    setPending(true);
    setFailure(null);
    const res = await postAction<BulkPreflightDto>('/api/app/bulk/preflight', { ...action(), workspaceSlug: props.workspaceSlug }, csrfToken);
    setPending(false);
    if (res.ok) setPreflight(res.data);
    else setFailure(res.message);
  }

  async function confirm() {
    requestKey.current ??= newRequestKey();
    setPending(true);
    setFailure(null);
    const res = await postAction<{ run: BulkRunDto }>('/api/app/bulk/runs', { ...action(), requestKey: requestKey.current, workspaceSlug: props.workspaceSlug }, csrfToken);
    setPending(false);
    if (!res.ok) {
      setFailure(res.message);
      return;
    }
    setRun(res.data.run);
    setOpen(false);
    setDrawerOpen(true);
    props.onClear();
  }

  // Follow the persisted run until every selected row has a result.
  const running = run !== null && run.status !== 'COMPLETED';
  const { exhausted } = usePolling(running, () => {
    if (!run) return;
    void fetch(`/api/app/bulk/runs/${encodeURIComponent(run.id)}?${new URLSearchParams({ workspaceSlug: props.workspaceSlug }).toString()}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<{ run: BulkRunDto }>) : null))
      .then((data) => {
        if (data) setRun(data.run);
      })
      .catch(() => undefined);
  });

  function openDialog() {
    requestKey.current = null;
    setPreflight(null);
    setFailure(null);
    setOpen(true);
  }

  const canSend = templateGate === null && (channel === 'SEND_EMAIL' ? subject.trim().length > 0 && body.trim().length > 0 : templateId !== '');

  return (
    <>
      {count > 0 || run ? (
        <div role="region" aria-label="Bulk actions" className="flex flex-wrap items-center gap-3 rounded-lg border border-panel/35 bg-panel/8 px-3 py-2 text-sm">
          {count > 0 ? (
            <>
              <span className="tabular font-medium text-fg-1">{count === 1 ? '1 lead selected' : `${count} leads selected`}</span>
              <Button type="button" variant="ghost" size="sm" onClick={props.onClear}>
                Clear selection
              </Button>
              <GatedAction label="Bulk send" size="sm" icon={<Send aria-hidden="true" />} gate={props.sendGate} onAction={openDialog} />
            </>
          ) : null}
          {run ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setDrawerOpen(true)}>
              Show the last bulk result
            </Button>
          ) : null}
          {running && exhausted ? <span className="text-xs text-fg-2">The worker is taking longer than usual; reopen the result later.</span> : null}
        </div>
      ) : null}

      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Send to {count === 1 ? '1 selected lead' : `${count} selected leads`}</DialogTitle>
            <DialogDescription>
              Workspace: <span className="font-medium text-fg-1">{props.workspaceName}</span>. Check eligibility first: only eligible leads are queued, and every send is checked again at dispatch.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <label htmlFor={ids.channel} className="flex flex-col gap-1 text-sm text-fg-1">
              Channel
              <NativeSelect
                id={ids.channel}
                value={channel}
                onChange={(e) => {
                  setChannel(e.target.value === 'SEND_WHATSAPP_TEMPLATE' ? 'SEND_WHATSAPP_TEMPLATE' : 'SEND_EMAIL');
                  edited();
                }}
              >
                <option value="SEND_EMAIL">Email</option>
                <option value="SEND_WHATSAPP_TEMPLATE">WhatsApp approved template</option>
              </NativeSelect>
            </label>
            {channel === 'SEND_EMAIL' ? (
              <>
                <label htmlFor={ids.subject} className="flex flex-col gap-1 text-sm text-fg-1">
                  Subject
                  <Input
                    id={ids.subject}
                    value={subject}
                    maxLength={200}
                    onChange={(e) => {
                      setSubject(e.target.value);
                      edited();
                    }}
                  />
                </label>
                <label htmlFor={ids.body} className="flex flex-col gap-1 text-sm text-fg-1">
                  Message
                  <Textarea
                    id={ids.body}
                    value={body}
                    maxLength={5000}
                    aria-describedby={`${ids.body}-hint`}
                    onChange={(e) => {
                      setBody(e.target.value);
                      edited();
                    }}
                  />
                </label>
                <span id={`${ids.body}-hint`} className="-mt-2 text-xs text-fg-2">
                  The unsubscribe link is added to every email at dispatch.
                </span>
              </>
            ) : templateGate ? (
              <GateReason id={ids.gate} gate={templateGate} />
            ) : (
              <>
                <label htmlFor={ids.template} className="flex flex-col gap-1 text-sm text-fg-1">
                  Template
                  <NativeSelect
                    id={ids.template}
                    value={templateId}
                    onChange={(e) => {
                      setTemplateId(e.target.value);
                      edited();
                    }}
                  >
                    {props.templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.language})
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label htmlFor={ids.vars} className="flex flex-col gap-1 text-sm text-fg-1">
                  Template values
                  <Textarea
                    id={ids.vars}
                    value={variables}
                    placeholder={'One value per line: the first fills {{1}}, the second {{2}}'}
                    onChange={(e) => {
                      setVariables(e.target.value);
                      edited();
                    }}
                  />
                </label>
              </>
            )}

            {preflight ? (
              <section aria-label="Eligibility" className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-bg-2/50 p-3">
                <ul className="flex flex-wrap gap-2">
                  <li>
                    <ToneChip tone="success" icon={CircleCheck} label={`${preflight.eligible} eligible`} />
                  </li>
                  <li>
                    <ToneChip tone="warning" icon={CircleSlash} label={`${preflight.skipped} skipped`} />
                  </li>
                  <li>
                    <ToneChip tone="danger" icon={CircleX} label={`${preflight.failed} failed`} />
                  </li>
                </ul>
                {preflight.byReason.length > 0 ? (
                  <ul aria-label="Why leads would not be queued" className="flex flex-col gap-1 text-sm text-fg-2">
                    {preflight.byReason.map((r) => (
                      <li key={r.code} className="flex justify-between gap-3">
                        <span>{r.label}</span>
                        <span className="tabular text-fg-1">{r.count}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}
            {failure ? (
              <p role="alert" className="rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-fg-1">
                {failure}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {preflight && preflight.eligible > 0 ? (
              <Button type="button" aria-busy={pending || undefined} onClick={() => void confirm()}>
                <Send aria-hidden="true" />
                {preflight.eligible === 1 ? 'Queue 1 eligible send' : `Queue ${preflight.eligible} eligible sends`}
              </Button>
            ) : (
              <Button type="button" variant={preflight ? 'outline' : 'default'} aria-busy={pending || undefined} disabled={!canSend} onClick={() => void check()}>
                <ShieldCheck aria-hidden="true" />
                {preflight ? 'Check again' : 'Check eligibility'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {run ? (
        <BulkResultSummary
          run={run}
          workspaceName={props.workspaceName}
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          onSelectRows={(rows) => {
            props.onSelectRows(rows);
            setDrawerOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
