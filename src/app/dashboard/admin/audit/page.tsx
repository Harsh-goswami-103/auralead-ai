/**
 * Platform admin: audit log (T29, R33). The platform-wide audit history, newest first, searchable
 * by actor (email or user id), action prefix, target type and id, workspace (slug or id), result,
 * India calendar days and correlation id, with keyset paging. Summaries and reasons are redacted
 * (field names, counts and codes only; never PII or secrets); there is no export. Rows link to
 * the workspace and person they concern, and the correlation id narrows to one request's chain.
 *
 * Look (design spec §6): PageHeader, the GET search form, then one list (it reads well at every
 * width): action label with its code, result chip (icon + label), actor, target, workspace, time,
 * reason and the redacted summary as compact JSON. Newest/Older paging.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronLeft, ChevronRight, ScrollText } from 'lucide-react';
import { ACTOR_KIND_LABELS, ADMIN_ACTION_LABELS, AUDIT_RESULT_VOCABULARY } from '@/components/admin/people-vocabulary';
import { SearchForm } from '@/components/admin/SearchForm';
import { SectionTitle } from '@/components/admin/SectionTitle';
import { StatusChip } from '@/components/admin/StatusChip';
import { EmptyState } from '@/components/patterns/EmptyState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format/date';
import { AUDIT_RESULTS, AuditSearchQuery } from '@/lib/schemas/admin-people';
import { getPageContext } from '@/server/auth/page-context';
import { searchAudit, type AuditRow } from '@/server/services/admin/audit-search';

export const metadata: Metadata = { title: 'Audit log' };
export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;
const KEYS = ['actor', 'action', 'targetType', 'targetId', 'workspace', 'result', 'from', 'to', 'correlationId'] as const;

function summaryText(summary: unknown): string | null {
  if (summary === null || typeof summary !== 'object') return null;
  const entries = Object.entries(summary as Record<string, unknown>);
  if (entries.length === 0) return null;
  return JSON.stringify(summary);
}

function Row({ row }: { row: AuditRow }) {
  const actorKind = ACTOR_KIND_LABELS[row.actorKind] ?? { label: row.actorKind, icon: ScrollText };
  const ActorIcon = actorKind.icon;
  const summary = summaryText(row.summary);
  const label = ADMIN_ACTION_LABELS[row.action];
  return (
    <li data-audit-row={row.action} className="flex flex-col gap-1.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-sm text-fg-1">
          {label ? `${label} ` : null}
          <span className="font-mono text-[13px] break-all text-fg-2">{row.action}</span>
        </span>
        <span className="flex items-center gap-2">
          {row.crossWorkspace ? <span className="rounded-full border border-panel/40 bg-panel/10 px-2 py-0.5 text-xs text-fg-1">Administrator</span> : null}
          <StatusChip entry={AUDIT_RESULT_VOCABULARY[row.result]} state={row.result} />
        </span>
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-2">
        <span className="inline-flex items-center gap-1">
          <ActorIcon aria-hidden="true" className="size-3.5 shrink-0 text-fg-3" />
          {row.actor ? (
            <Link href={`/dashboard/admin/people/${row.actor.id}`} className="text-cyan underline-offset-4 hover:underline">
              {row.actor.name}
            </Link>
          ) : (
            actorKind.label
          )}
        </span>
        <span>
          · {row.targetType} <span className="font-mono break-all">{row.targetId}</span>
        </span>
        {row.workspace ? (
          <span>
            ·{' '}
            <Link href={`/dashboard/admin/workspaces/${row.workspace.id}`} className="text-cyan underline-offset-4 hover:underline">
              {row.workspace.name}
            </Link>
          </span>
        ) : null}
        <span className="tabular">· {formatDateTime(row.createdAt)}</span>
        <Link href={`/dashboard/admin/audit?correlationId=${encodeURIComponent(row.correlationId)}`} className="font-mono text-cyan underline-offset-4 hover:underline" aria-label={`Show every event of request ${row.correlationId}`}>
          {row.correlationId}
        </Link>
      </p>
      {row.reason ? <p className="text-xs text-fg-1">Reason: “{row.reason}”</p> : null}
      {summary ? <p className="font-mono text-xs break-all text-fg-2">{summary}</p> : null}
    </li>
  );
}

export default async function AdminAuditPage(props: { searchParams: Promise<Search> }) {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const search = await props.searchParams;
  const raw: Record<string, string> = {};
  for (const key of [...KEYS, 'before'] as const) {
    const v = search[key];
    if (typeof v === 'string' && v.trim() !== '') raw[key] = v.trim();
  }
  const parsed = AuditSearchQuery.safeParse(raw);
  const query = parsed.success ? parsed.data : {};
  const result = await searchAudit(page.ctx, query);
  const filters = Object.fromEntries(KEYS.map((k) => [k, (query as Record<string, string | undefined>)[k]]));
  const filtered = KEYS.some((k) => filters[k]);
  const href = (extra: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, ...extra })) if (v) q.set(k, v);
    const s = q.toString();
    return `/dashboard/admin/audit${s ? `?${s}` : ''}`;
  };
  const v = (k: (typeof KEYS)[number]) => filters[k] ?? '';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Platform admin"
        title="Audit log"
        description="Every recorded action across the platform. Summaries name fields and counts only; contacts and secrets are never shown or exported."
        meta={`${result.rows.length} shown${query.before ? ' from an older page' : ''}`}
      />
      <SectionCard title={<SectionTitle icon={<ScrollText />} hue="aura">Search</SectionTitle>} meta="Action matches a prefix (quote. finds every quotation action). Dates are India calendar days, both inclusive.">
        {parsed.success ? null : (
          <p role="alert" className="text-sm text-danger">
            Some filters were not understood and were ignored. Dates use the YYYY-MM-DD form.
          </p>
        )}
        <SearchForm
          idPrefix="audit"
          clearHref={filtered ? '/dashboard/admin/audit' : null}
          fields={[
            { kind: 'text', name: 'actor', label: 'Actor (email or user id)', value: v('actor') },
            { kind: 'text', name: 'action', label: 'Action (prefix)', value: v('action'), placeholder: 'workspace.', mono: true },
            { kind: 'text', name: 'targetType', label: 'Target type', value: v('targetType'), placeholder: 'User' },
            { kind: 'text', name: 'targetId', label: 'Target id', value: v('targetId'), mono: true },
            { kind: 'text', name: 'workspace', label: 'Workspace (slug or id)', value: v('workspace'), mono: true },
            { kind: 'select', name: 'result', label: 'Result', value: v('result'), options: AUDIT_RESULTS.map((r) => ({ value: r, label: AUDIT_RESULT_VOCABULARY[r].label })) },
            { kind: 'date', name: 'from', label: 'From (IST)', value: v('from') },
            { kind: 'date', name: 'to', label: 'To (IST)', value: v('to') },
            { kind: 'text', name: 'correlationId', label: 'Correlation id', value: v('correlationId'), mono: true },
          ]}
        />
      </SectionCard>
      <SectionCard title={<SectionTitle icon={<ScrollText />}>Events</SectionTitle>} meta="Newest first.">
        {result.rows.length === 0 ? (
          <EmptyState
            headingLevel="h3"
            icon={<ScrollText />}
            title={result.unknownActor ? 'No account has that email' : result.unknownWorkspace ? 'No workspace has that slug or id' : 'No events match'}
            description={filtered ? 'Change or clear the filters to see more of the history.' : 'Nothing has been recorded yet.'}
            action={
              filtered ? (
                <Button asChild variant="secondary">
                  <Link href="/dashboard/admin/audit">Clear filters</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul aria-label="Audit events" className="flex flex-col divide-y divide-border-subtle">
            {result.rows.map((row) => (
              <Row key={row.id} row={row} />
            ))}
          </ul>
        )}
        {result.nextCursor || query.before ? (
          <nav aria-label="Audit pages" className="flex flex-wrap items-center gap-2">
            {query.before ? (
              <Button asChild variant="outline" size="sm">
                <Link href={href({})}>
                  <ChevronLeft aria-hidden="true" />
                  Newest
                </Link>
              </Button>
            ) : null}
            {result.nextCursor ? (
              <Button asChild variant="outline" size="sm">
                <Link href={href({ before: result.nextCursor })}>
                  Older
                  <ChevronRight aria-hidden="true" />
                </Link>
              </Button>
            ) : null}
          </nav>
        ) : null}
      </SectionCard>
    </div>
  );
}
