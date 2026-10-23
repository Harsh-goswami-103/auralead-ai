/**
 * Operator lead import (ADR-120, slice F2): upload an Excel (.xlsx) or CSV file, check the column
 * mapping suggested from the header names on a preview of the first 20 rows, say where the list
 * came from, confirm, follow the import while the worker processes it 200 rows at a time, and read
 * the counts and row-level reasons. "Download sample workbook" gives the expected columns; the
 * instructions live on this page, never in the workbook's data sheet. The `[ws]` slug is resolved
 * against the employee's active assignments (404 otherwise). Uploading needs leads.import (the
 * button stays focusable with the reason otherwise); the WhatsApp opt-in section is shown to a
 * holder of consent.import only (an owner, ADR-120).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, FileDown, FileSpreadsheet, History, ListChecks, Users } from 'lucide-react';
import { WorkspaceSectionNav } from '@/components/integrations/WorkspaceSectionNav';
import { ImportWorkspace } from '@/components/leads/import/ImportWorkspace';
import { RecentImports } from '@/components/leads/import/RecentImports';
import { ChipTitle } from '@/components/patterns/IconChip';
import { EmptyState } from '@/components/patterns/EmptyState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { buttonVariants } from '@/components/ui/button';
import { NotFoundError } from '@/lib/errors';
import { LEAD_IMPORT_CHUNK, LEAD_IMPORT_MAX_ROWS, LEAD_IMPORT_SAMPLE_WORKBOOK_PATH, LEAD_IMPORT_TTL_HOURS } from '@/lib/schemas/lead-import';
import { getRuntime } from '@/server/boot';
import { getPageContext } from '@/server/auth/page-context';
import { loadLeadImportPage } from '@/server/services/leads/import';

export const metadata: Metadata = { title: 'Import leads' };
export const dynamic = 'force-dynamic';

export default async function EmployeeLeadImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ ws: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ws } = await params;
  const query = (await searchParams) ?? {};
  const importId = typeof query.import === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(query.import) ? query.import : null;
  let page;
  try {
    page = await getPageContext({ workspaceSlug: ws });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  if (!page) redirect('/login');
  if (page.session.user.globalRole !== 'EMPLOYEE') notFound();

  const data = await loadLeadImportPage(page.ctx, { importId, storageDir: getRuntime().config.paths.storageDir });
  const leadsHref = `/dashboard/employee/${data.workspace.slug}/leads`;
  const basePath = `${leadsHref}/import`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={data.workspace.name}
        title="Import leads"
        description="Bring in a list of businesses from Excel or CSV. Each row goes through the same duplicate checks and scoring as leads from every other source."
        actions={
          <>
            <a href={LEAD_IMPORT_SAMPLE_WORKBOOK_PATH} download className={buttonVariants({ variant: 'secondary' })}>
              <FileDown aria-hidden="true" />
              Download sample workbook
            </a>
            <Link href={leadsHref} className={buttonVariants({ variant: 'outline' })}>
              <ArrowLeft aria-hidden="true" />
              Lead console
            </Link>
          </>
        }
      />
      <WorkspaceSectionNav slug={data.workspace.slug} workspaceName={data.workspace.name} />

      {!data.canRead ? (
        <EmptyState
          icon={<Users aria-hidden="true" className="size-5" />}
          title="Leads are not part of your assignment"
          description="Your assignment in this workspace does not include leads.read. A super admin can grant it from the people page."
        />
      ) : (
        <>
          <SectionCard title={<ChipTitle icon={<FileSpreadsheet aria-hidden="true" />} hue="volt">Upload a spreadsheet</ChipTitle>}>
            <ImportWorkspace
              workspaceSlug={data.workspace.slug}
              basePath={basePath}
              leadsHref={leadsHref}
              gate={data.canImport ? null : { category: 'permission', reason: 'Your assignment does not include leads.import, which importing leads needs. A super admin can grant it from the people page.' }}
              consent={{ allowed: data.canImportConsent, noticeDefault: data.noticeDefault, attestationText: data.attestationText, businessName: data.workspace.name }}
              initial={data.current}
            />
          </SectionCard>

          <SectionCard title={<ChipTitle icon={<ListChecks aria-hidden="true" />} hue="ice">How to prepare the file</ChipTitle>}>
            <ul className="flex max-w-prose list-disc flex-col gap-1.5 pl-5 text-sm text-fg-2">
              <li>Keep the column names in the first row and one business per row below it. The sample workbook shows every column this page recognises.</li>
              <li>
                Each row needs a business name and a phone number or email. Indian numbers can be written with or without +91 and spaces; ratings like 4.5 and review counts like 1,234 are read as numbers.
              </li>
              <li>
                Up to {LEAD_IMPORT_MAX_ROWS.toLocaleString('en-IN')} rows and 5 MB per file; the worker imports {LEAD_IMPORT_CHUNK} rows at a time. Excel files are read from their first sheet; formulas are not evaluated, so save the values.
              </li>
              <li>
                An uploaded file is kept for {LEAD_IMPORT_TTL_HOURS} hours until you confirm it and deleted once the import finishes. Only row numbers and reasons are kept for rows that were not imported, never their contents.
              </li>
              <li>
                Imported leads have no WhatsApp opt-in. A WhatsApp opt-in column is honoured only when the workspace owner attests that the business collected the list itself with a notice naming the business and WhatsApp, with a date for each opt-in. Anyone who replied STOP stays opted out.
              </li>
            </ul>
          </SectionCard>

          {data.recent.length > 0 ? (
            <SectionCard title={<ChipTitle icon={<History aria-hidden="true" />}>Your recent imports</ChipTitle>} meta="Imports you started in this workspace, newest first.">
              <RecentImports imports={data.recent} basePath={basePath} timeZone={data.workspace.timezone} />
            </SectionCard>
          ) : null}
        </>
      )}
    </div>
  );
}
