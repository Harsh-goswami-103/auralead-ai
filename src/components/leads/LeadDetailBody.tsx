/**
 * The body of a lead's detail (T26, R31): shared by the client panel's detail sheet and lead page
 * and the operator console's lead page. Sections: stage (with the "Move to stage" control when the
 * viewer holds leads.write, otherwise the permission reason), contact and business facts, the score
 * breakdown, consent per channel, the source records, and links to the lead's quotations and
 * conversations when the panel has pages for them. All data comes from `loadLeadProfile`.
 * Server-safe (the stage control inside is a client component).
 */
import Link from 'next/link';
import { Contact, FileText, Gauge, Globe, Inbox, Mail, MapPin, MessageCircle, Phone, ShieldCheck, Star, Tag, Waypoints, type LucideIcon } from 'lucide-react';
import { ChipTitle } from '@/components/patterns/IconChip';
import { GatedAction } from '@/components/patterns/GatedAction';
import { SourceChip } from '@/components/patterns/SourceChip';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { cn } from '@/components/ui/cn';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { formatINR } from '@/lib/money';
import type { LeadProfileDto } from '@/lib/schemas/leads';
import { ConsentChips } from './ConsentChips';
import { RecordOptIn } from './RecordOptIn';
import { WEBSITE_LABELS } from './lead-vocabulary';
import { ScoreBreakdown } from './ScoreBreakdown';
import { SourceRecords } from './SourceRecords';
import { StageChip } from './StageChip';
import { StageMoveMenu } from './StageMoveMenu';

function Fact({ label, icon: Icon, children, className }: { label: string; icon: LucideIcon; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <dt className="flex items-center gap-1.5 text-xs text-fg-2">
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-fg-3" />
        {label}
      </dt>
      <dd className="text-sm break-words text-fg-1">{children}</dd>
    </div>
  );
}

function Section(props: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border-subtle pt-4 first:border-t-0 first:pt-0">
      <h3 className="font-display text-base font-semibold text-fg-1">{props.title}</h3>
      {props.children}
    </section>
  );
}

export function LeadDetailBody(props: {
  profile: LeadProfileDto;
  /** Operator console: the workspace the stage route acts in. */
  workspaceSlug?: string;
  /** Client panel: links to the quotation and inbox pages. */
  links?: { quote: (id: string) => string; conversation: (id: string) => string; quoteStatus: (status: string) => React.ReactNode };
}) {
  const { lead, workspace } = props.profile;
  const tz = workspace.timezone;
  const website = WEBSITE_LABELS[lead.websiteStatus] ?? lead.websiteStatus;

  return (
    <div className="flex flex-col gap-5" data-lead-detail={lead.id}>
      <Section title={<ChipTitle icon={<Waypoints aria-hidden="true" />} hue="zest">Stage</ChipTitle>}>
        <div className="flex flex-wrap items-center gap-2">
          <StageChip stage={lead.salesStage} />
          <SourceChip source={lead.firstSource} withIcon />
          {lead.simulated ? <ModeChip simulated /> : null}
          <span className="text-xs text-fg-2">Added {formatDateTime(new Date(lead.createdAt), tz)}</span>
        </div>
        {lead.merged ? (
          <p className="text-sm text-fg-2">This lead was merged into another lead; its stage is kept there.</p>
        ) : props.profile.permissions.canMoveStage ? (
          <StageMoveMenu lead={lead} workspaceSlug={props.workspaceSlug} className="self-start" />
        ) : (
          <GatedAction label="Move to stage" size="sm" gate={{ category: 'permission', reason: 'Moving leads between stages needs leads.write, which you do not hold in this workspace.' }} />
        )}
      </Section>

      <Section title={<ChipTitle icon={<Contact aria-hidden="true" />}>Contact and business</ChipTitle>}>
        <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <Fact label="Phone" icon={Phone}>
            {lead.phoneE164 ?? 'None on record'}
          </Fact>
          <Fact label="Email" icon={Mail}>
            {lead.emailNormalized ?? 'None on record'}
          </Fact>
          <Fact label="Website" icon={Globe}>
            {lead.website ? `${lead.website} (${website})` : website}
          </Fact>
          <Fact label="Category" icon={Tag}>
            {lead.category ?? 'Unknown'}
          </Fact>
          <Fact label="City" icon={MapPin}>
            {lead.city ?? 'Unknown'}
          </Fact>
          <Fact label="Address" icon={MapPin}>
            {lead.address ?? 'Unknown'}
          </Fact>
          <Fact label="Rating" icon={Star} className="sm:col-span-2">
            {lead.ratingX10 === null ? 'Unknown' : `${(lead.ratingX10 / 10).toFixed(1)} stars${lead.reviewCount === null ? '' : ` from ${lead.reviewCount} reviews`}`}
          </Fact>
        </dl>
      </Section>

      <Section title={<ChipTitle icon={<Gauge aria-hidden="true" />} hue="volt">Score</ChipTitle>}>
        <ScoreBreakdown score={lead.score} configVersion={props.profile.score.configVersion} reasons={props.profile.score.reasons} unknownInputs={props.profile.score.unknownInputs} />
      </Section>

      <Section title={<ChipTitle icon={<ShieldCheck aria-hidden="true" />} hue="ice">Consent</ChipTitle>}>
        <ConsentChips consent={props.profile.consent} timeZone={tz} />
        <RecordOptIn
          leadId={lead.id}
          displayName={lead.displayName}
          consent={props.profile.consent}
          phoneE164={lead.phoneE164}
          emailNormalized={lead.emailNormalized}
          canRecord={props.profile.permissions.canRecordConsent}
          workspaceSlug={props.workspaceSlug}
        />
      </Section>

      <Section title={<ChipTitle icon={<Inbox aria-hidden="true" />}>Source</ChipTitle>}>
        <SourceRecords records={props.profile.sources} timeZone={tz} />
      </Section>

      {props.links ? (
        <Section title={<ChipTitle icon={<FileText aria-hidden="true" />}>Quotations and conversations</ChipTitle>}>
          {props.profile.quotes.length === 0 && props.profile.conversations.length === 0 ? (
            <p className="text-sm text-fg-2">No quotation or conversation yet.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {props.profile.quotes.map((q) => (
                <li key={q.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link href={props.links!.quote(q.id)} className="inline-flex items-center gap-1.5 font-medium text-cyan underline-offset-4 hover:underline">
                    <FileText aria-hidden="true" className="size-4" />
                    {q.number} v{q.currentVersionNo}
                  </Link>
                  {props.links!.quoteStatus(q.status)}
                  <span className="tabular text-fg-1">{q.totalPaise === null ? 'Not priced' : formatINR(BigInt(q.totalPaise))}</span>
                  {q.validUntil ? <span className="text-xs text-fg-2">Valid until {formatDate(new Date(q.validUntil), tz)}</span> : null}
                </li>
              ))}
              {props.profile.conversations.map((c) => (
                <li key={c.id}>
                  <Link href={props.links!.conversation(c.id)} className="inline-flex items-center gap-1.5 font-medium text-cyan underline-offset-4 hover:underline">
                    {c.channel === 'WHATSAPP' ? <MessageCircle aria-hidden="true" className="size-4" /> : <Mail aria-hidden="true" className="size-4" />}
                    {c.channel === 'WHATSAPP' ? 'WhatsApp conversation' : 'Email conversation'}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}
    </div>
  );
}
