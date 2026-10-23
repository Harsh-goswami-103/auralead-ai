/**
 * Lead finder for one workspace (ADR-118, slice F1; plan §0 story step 1): find businesses on
 * Google Maps by keywords x locations (LIVE: Google Places API (New) on the workspace's own key;
 * DEMO: a simulated directory that echoes the search, labelled Simulated), watch the searches
 * progress, filter the results (No website listed, Has phone, Not imported), import the selected
 * ones as leads and download the run as Excel.
 *
 * The `[ws]` slug is resolved against the employee's assignments (404 outside them); reading needs
 * `leads.read`. Starting a search needs `finder.run` and, in LIVE, a saved Google Places key
 * (a configuration gate linking to the setup); importing needs `leads.write`; the Excel file needs
 * `leads.export` and is for the person who started the run. LIVE shows the Google Maps attribution
 * with the results; DEMO the Simulated chip. Results are a 24-hour working copy (ADR-118 (a)).
 */
import type { Metadata } from 'next';
import { History, ListChecks, MapPinned, Search } from 'lucide-react';
import { setupHref } from '@/components/integrations/IntegrationCard';
import { NotInAssignment } from '@/components/integrations/NotInAssignment';
import { WorkspaceSectionNav } from '@/components/integrations/WorkspaceSectionNav';
import { CAPABILITY_LABELS } from '@/components/admin/people-vocabulary';
import { FinderResults } from '@/components/finder/FinderResults';
import { FinderRunForm } from '@/components/finder/FinderRunForm';
import { FinderRunsList } from '@/components/finder/FinderRunsList';
import { EmptyState } from '@/components/patterns/EmptyState';
import type { Gate } from '@/components/patterns/GatedAction';
import { ChipTitle } from '@/components/patterns/IconChip';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { FinderResultsQuery } from '@/server/services/lead-finder/schemas';
import { getFinderPage, type FinderPageModel } from '@/server/services/lead-finder/view';
import { readOrNull, workspacePage } from '../integrations/_lib/workspace-page';

export const metadata: Metadata = { title: 'Lead finder' };
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function permission(capability: keyof typeof CAPABILITY_LABELS): Gate {
  return { category: 'permission', reason: `Your assignment here does not include “${CAPABILITY_LABELS[capability].label}”. A super admin can grant it.` };
}

function runGate(model: FinderPageModel, ws: string): Gate | null {
  if (!model.can.run) return permission('finder.run');
  if (model.mode === 'live' && !model.places.configured) {
    return { category: 'configuration', reason: 'Save a Google Places API key first: searches run on your own key.', fix: { href: setupHref(ws, 'google-places'), label: 'Set up Google Places' } };
  }
  return null;
}

export default async function FinderPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams?: Promise<SearchParams> }) {
  const { ws } = await params;
  const sp = (await searchParams) ?? {};
  const page = await workspacePage(ws);
  const query = FinderResultsQuery.safeParse({ noWebsite: one(sp.noWebsite), hasPhone: one(sp.hasPhone), notImported: one(sp.notImported), page: one(sp.page) });
  const filters = query.success ? { noWebsite: query.data.noWebsite, hasPhone: query.data.hasPhone, notImported: query.data.notImported } : { noWebsite: false, hasPhone: false, notImported: false };
  const runParam = one(sp.run);
  const model = await readOrNull(() => getFinderPage(page.ctx, { runId: runParam && /^[A-Za-z0-9_-]{1,64}$/.test(runParam) ? runParam : null, filters, page: query.success ? query.data.page : 1 }));
  const name = model?.workspace.name ?? ws;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={name}
        title="Lead finder"
        description={
          model?.mode === 'demo'
            ? 'Search a simulated business directory by keyword and location, import the businesses you want as leads and download the list. DEMO never contacts Google.'
            : 'Find businesses on Google Maps by keyword and location through the Google Places API, import the ones you want as leads and download the list.'
        }
        meta={model?.mode === 'demo' ? <ModeChip simulated /> : undefined}
      />
      <WorkspaceSectionNav slug={ws} workspaceName={name} />
      {model === null ? (
        <NotInAssignment what="The lead finder" />
      ) : (
        <>
          <SectionCard
            title={
              <ChipTitle icon={<Search aria-hidden="true" />} hue="ice">
                New search
              </ChipTitle>
            }
            meta={
              model.mode === 'live'
                ? 'Results are kept for 24 hours as a working copy; place IDs, keywords and imported leads stay. Places leads have no WhatsApp opt-in.'
                : 'Simulated listings follow your keywords and locations. Places leads have no WhatsApp opt-in, here as in LIVE.'
            }
          >
            <FinderRunForm workspaceSlug={ws} mode={model.mode} gate={runGate(model, ws)} />
          </SectionCard>

          <SectionCard
            title={
              <ChipTitle icon={<History aria-hidden="true" />} hue="aura">
                Searches
              </ChipTitle>
            }
          >
            {model.runs.length === 0 ? (
              <EmptyState headingLevel="h3" icon={<MapPinned aria-hidden="true" className="size-5" />} title="No search yet" description="Start one above: every keyword is searched in every location." />
            ) : (
              <FinderRunsList runs={model.runs} selectedId={model.view?.run.id ?? null} workspaceSlug={ws} timeZone={model.workspace.timezone} cancelGate={model.can.run ? null : permission('finder.run')} />
            )}
          </SectionCard>

          {model.view ? (
            <SectionCard
              title={
                <ChipTitle icon={<ListChecks aria-hidden="true" />} hue="zest">
                  Results
                </ChipTitle>
              }
              meta={`${model.view.run.keywords.join(', ')} in ${model.view.run.locations.join(', ')}: ${model.view.counts.all.toLocaleString('en-IN')} ${model.view.counts.all === 1 ? 'place' : 'places'}.`}
            >
              <FinderResults
                view={model.view}
                workspaceSlug={ws}
                importGate={model.can.import ? null : permission('leads.write')}
                exportGate={!model.can.export ? permission('leads.export') : model.view.run.requestedByViewer ? null : { category: 'permission', reason: 'Only the person who ran this search can download its file.' }}
                refreshGate={runGate(model, ws)}
              />
            </SectionCard>
          ) : null}
        </>
      )}
    </div>
  );
}
