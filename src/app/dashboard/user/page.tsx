/**
 * Client panel home (T09, M1): the signed-in owner's workspace, read through the tenant-scoped
 * context: catalog priced from the active pricing version, quote settings, the active scoring
 * and pipeline versions and the team. Later tasks add the DB-derived command-center metrics.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { formatDate } from '@/lib/format/date';
import { formatINR } from '@/lib/money';
import { getPageContext } from '@/server/auth/page-context';
import { loadUserHome } from '@/server/services/shell/panel-home';

export const metadata: Metadata = { title: 'Command center' };
export const dynamic = 'force-dynamic';

const percent = (bps: number) => `${(bps / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;

function Section(props: { title: string; meta?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flex flex-col gap-4 rounded-xl border border-border-subtle bg-bg-1 p-5 ${props.className ?? ''}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg font-semibold text-fg-1">{props.title}</h2>
        {props.meta ? <span className="text-sm text-fg-2">{props.meta}</span> : null}
      </div>
      {props.children}
    </section>
  );
}

function Row(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border-subtle py-2 last:border-b-0">
      <dt className="text-fg-2">{props.label}</dt>
      <dd className="text-right text-fg-1">{props.children}</dd>
    </div>
  );
}

export default async function UserHomePage() {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const home = await loadUserHome(page.ctx);
  const { workspace, settings, pipeline } = home;
  const tz = workspace.timezone;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-fg-2">Command center</p>
        <h1 className="font-display text-2xl font-semibold text-fg-1 sm:text-3xl">{workspace.name}</h1>
        <p className="text-fg-2">
          {workspace.role === 'OWNER' ? 'Owner' : 'Member'} · {workspace.planLabel} plan · {tz} · on AuraLead since {formatDate(workspace.createdAt, tz)}
        </p>
      </header>

      <div className="grid gap-6 xl:grid-cols-3">
        <Section
          title="Service catalog"
          meta={home.pricing ? `Price list v${home.pricing.version}, ${formatDate(home.pricing.createdAt, tz)}` : 'No active price list'}
          className="xl:col-span-2"
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left">
              <caption className="sr-only">Services and unit prices from the active price list</caption>
              <thead className="text-xs text-fg-2">
                <tr className="border-b border-border-subtle">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Service
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Code
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Typical timeline
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Unit price
                  </th>
                </tr>
              </thead>
              <tbody>
                {home.services.map((s) => (
                  <tr key={s.code} className="border-b border-border-subtle last:border-b-0">
                    <td className="py-2.5 pr-3 text-fg-1">{s.name}</td>
                    <td className="py-2.5 pr-3 font-mono text-xs text-fg-2">{s.code}</td>
                    <td className="tabular py-2.5 pr-3 text-fg-2">{s.defaultTimelineDays === null ? 'Not set' : `${s.defaultTimelineDays} days`}</td>
                    <td className="tabular py-2.5 text-right text-fg-1">
                      {s.unitPricePaise === null ? 'Not priced' : formatINR(s.unitPricePaise)}
                      <span className="text-fg-3"> / {s.unitLabel}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Quote settings">
          {settings ? (
            <dl className="flex flex-col">
              <Row label="Tax">{settings.taxMode === 'CONFIGURED' && settings.taxBps !== null ? `${settings.taxLabel ?? 'Tax'} ${percent(settings.taxBps)}` : 'No tax'}</Row>
              <Row label="Maximum discount">{percent(settings.maxDiscountBps)}</Row>
              <Row label="Quote validity">{settings.quoteValidityDays} days</Row>
              <Row label="Automatic sending">{settings.autoSendEnabled ? 'On' : 'Off (every send needs a person)'}</Row>
            </dl>
          ) : (
            <p className="text-fg-2">Quote settings have not been created for this workspace.</p>
          )}
        </Section>

        <Section title="Active configuration">
          <dl className="flex flex-col">
            <Row label="Price list">{home.pricing ? `v${home.pricing.version}` : 'None'}</Row>
            <Row label="Lead scoring">{home.scoring ? `v${home.scoring.version}, since ${formatDate(home.scoring.createdAt, tz)}` : 'None'}</Row>
            <Row label="Pipeline">{pipeline ? `v${pipeline.version}, ${pipeline.approvalMode === 'HUMAN' ? 'human approval' : 'policy approval'}` : 'None'}</Row>
          </dl>
          {pipeline ? (
            <ol aria-label="Pipeline stages" className="flex flex-wrap items-center gap-1.5 text-xs">
              {pipeline.stages.map((stage, i) => (
                <li key={stage} className="flex items-center gap-1.5">
                  <span className="rounded-full border border-border-strong bg-bg-2 px-2 py-0.5 text-fg-1">{stage}</span>
                  {i < pipeline.stages.length - 1 ? (
                    <span aria-hidden="true" className="text-fg-3">
                      →
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
        </Section>

        <Section title="Team" meta={`${home.members.length} ${home.members.length === 1 ? 'person' : 'people'}`}>
          <ul className="flex flex-col">
            {home.members.map((m) => (
              <li key={`${m.name}-${m.role}`} className="flex items-center justify-between border-b border-border-subtle py-2 last:border-b-0">
                <span className="text-fg-1">{m.name}</span>
                <span className="text-sm text-fg-2">{m.role === 'OWNER' ? 'Owner' : 'Member'}</span>
              </li>
            ))}
          </ul>
        </Section>

        {settings ? (
          <Section title="Quotation terms">
            <p className="text-sm whitespace-pre-line text-fg-2">{settings.termsText}</p>
          </Section>
        ) : null}
      </div>
    </div>
  );
}
