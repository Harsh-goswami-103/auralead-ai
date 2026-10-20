/**
 * Client panel lead page (T26, R31; plan §3 `dashboard/user/leads/[leadId]`): the same detail the
 * Leads sheet shows (stage control, contact facts, score breakdown, consent per channel, source
 * records, quotations and conversations) on its own URL, for a bookmark or a wide screen. A lead
 * of another workspace, or one that does not exist, is 404. Needs leads.read.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, Users } from 'lucide-react';
import { LeadDetailBody } from '@/components/leads/LeadDetailBody';
import { EmptyState } from '@/components/patterns/EmptyState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { touchTarget } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { NotFoundError, PermissionDeniedError } from '@/lib/errors';
import { getPageContext } from '@/server/auth/page-context';
import { getRuntime } from '@/server/boot';
import { leadProfileDeps, loadLeadProfile } from '@/server/services/leads/profile';
import { isQuoteStatus, QuoteStatusBadge } from '../../quotations/quote-status';

export const metadata: Metadata = { title: 'Lead' };
export const dynamic = 'force-dynamic';

export default async function UserLeadPage({ params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params;
  const page = await getPageContext();
  if (!page) redirect('/login');

  let profile;
  try {
    profile = await loadLeadProfile(page.ctx, leadId, leadProfileDeps(getRuntime().config));
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof PermissionDeniedError) {
      return (
        <EmptyState
          icon={<Users aria-hidden="true" className="size-5" />}
          title="Leads are not part of your access"
          description="Your membership in this workspace does not include leads.read. Ask the workspace owner."
        />
      );
    }
    throw error;
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/dashboard/user/leads" className={cn('group relative inline-flex w-fit items-center gap-1.5 text-sm text-fg-2 hover:text-fg-1', touchTarget)}>
        <ArrowLeft aria-hidden="true" className="size-4 transition-transform duration-fast motion-safe:group-hover:-translate-x-0.5" />
        All leads
      </Link>
      <PageHeader className="-mt-3" eyebrow={profile.workspace.name} title={profile.lead.displayName} description="Score, consent, source and stage of this lead." />
      <SectionCard>
        <LeadDetailBody
          profile={profile}
          links={{
            quote: (id) => `/dashboard/user/quotations/${encodeURIComponent(id)}`,
            conversation: (id) => `/dashboard/user/inbox/${encodeURIComponent(id)}`,
            quoteStatus: (status) => (isQuoteStatus(status) ? <QuoteStatusBadge status={status} /> : null),
          }}
        />
      </SectionCard>
    </div>
  );
}
