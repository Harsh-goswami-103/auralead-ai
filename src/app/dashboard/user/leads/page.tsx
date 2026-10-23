/**
 * Client panel Leads (T26, R31, plan §11 M4; 06-design "User Leads"): every lead of the workspace
 * with search on the normalized columns (any script), stage, source and score filters, sort, keyset
 * pages of 50 with a capped count, the Kanban board with its "Move to stage" menu and drag, the
 * lead detail sheet (`?lead=`: the handoff of a handed-over lead (lead-gen F5), stage control, score
 * breakdown, consent per channel, source records, quotations and conversations), and the CSV export. Everything is read on the server through the
 * tenant-scoped context; every change goes through /api/app/** routes and is audited there.
 *
 * Capabilities: reading needs leads.read (owners and members), moving stages leads.write, the
 * export leads.export (owners). The scoring configuration is shown read-only on its own tab (P9).
 */
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { Users } from 'lucide-react';
import { ClientHandoffSection } from '@/components/handoff/HandoffSection';
import { LeadDetailBody } from '@/components/leads/LeadDetailBody';
import { LeadSheet } from '@/components/leads/LeadSheet';
import { LeadsTabs } from '@/components/leads/LeadsTabs';
import { LeadsWorkspace } from '@/components/leads/LeadsWorkspace';
import { EmptyState } from '@/components/patterns/EmptyState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { NotFoundError } from '@/lib/errors';
import { leadPageSearch, parseLeadPageParams } from '@/lib/schemas/leads';
import { getPageContext } from '@/server/auth/page-context';
import { getRuntime } from '@/server/boot';
import { loadLeadHandoff, type LeadHandoffView } from '@/server/services/leads/handoff';
import { leadProfileDeps, loadLeadProfile } from '@/server/services/leads/profile';
import { isQuoteStatus, QuoteStatusBadge } from '../quotations/quote-status';
import { loadLeadsArea } from './leads-data';

export const metadata: Metadata = { title: 'Leads' };
export const dynamic = 'force-dynamic';

const BASE = '/dashboard/user/leads';

export default async function UserLeadsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const ctx = page.ctx;
  const params = parseLeadPageParams(await searchParams);

  let area;
  try {
    area = await loadLeadsArea(ctx, params, {
      basePath: BASE,
      rowHref: (row) => `${BASE}${leadPageSearch({ ...params, lead: undefined }, { lead: row.id })}`,
      gates: {
        move: 'Moving leads between stages needs leads.write. Ask the workspace owner.',
        export: 'Only the workspace owner can export leads (leads.export).',
      },
    });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { access } = area;

  let profile = null;
  let handoff: LeadHandoffView | null = null;
  if (params.lead && access.canRead) {
    try {
      [profile, handoff] = await Promise.all([loadLeadProfile(ctx, params.lead, leadProfileDeps(getRuntime().config)), loadLeadHandoff(ctx, params.lead)]);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }
  const closeHref = `${BASE}${leadPageSearch({ ...params, lead: undefined })}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={access.workspace.name}
        title="Leads"
        description="Every lead from your forms, ads, the Maps extension and inbound messages, with its score, consent and sales stage."
      />
      <LeadsTabs current="leads" leadsHref={BASE} scoringHref="/dashboard/user/leads/scoring" />

      {area.workspace === null ? (
        <EmptyState
          icon={<Users aria-hidden="true" className="size-5" />}
          title="Leads are not part of your access"
          description="Your membership in this workspace does not include leads.read. Ask the workspace owner."
        />
      ) : (
        <LeadsWorkspace
          {...area.workspace}
          emptyWorkspace={
            access.empty ? (
              <EmptyState
                headingLevel="h3"
                icon={<Users aria-hidden="true" className="size-5" />}
                title="No leads yet"
                description="Leads appear here when a connected source sends them: a Google Sheets form, Meta Lead Ads, the Maps extension or an inbound WhatsApp message."
              />
            ) : null
          }
        />
      )}

      {profile ? (
        <LeadSheet
          key={profile.lead.id}
          title={profile.lead.displayName}
          description={`${profile.workspace.name} · lead detail`}
          closeHref={closeHref}
          fullPageHref={`${BASE}/${encodeURIComponent(profile.lead.id)}`}
        >
          {/* Lead-gen F5 (ADR-124): a handed-over lead opens with the operator's note, the summary and Acknowledge. */}
          {handoff ? (
            <div className="mb-5">
              <ClientHandoffSection view={handoff} timeZone={profile.workspace.timezone} />
            </div>
          ) : null}
          <LeadDetailBody
            profile={profile}
            links={{
              quote: (id) => `/dashboard/user/quotations/${encodeURIComponent(id)}`,
              conversation: (id) => `/dashboard/user/inbox/${encodeURIComponent(id)}`,
              quoteStatus: (status) => (isQuoteStatus(status) ? <QuoteStatusBadge status={status} /> : null),
            }}
          />
        </LeadSheet>
      ) : null}
    </div>
  );
}
