/**
 * StatusBadge (06-design §11.6, F2): icon + label + mode chip, always. `simulated` is required so
 * no caller can render a status without saying whether it came from a simulator; the chip reads
 * "Simulated" (demo tone) or "Live". Server-renderable (no hooks). Aurora look (design spec §6):
 * rounded tone chip from TONE_CLASSES (12% tint, 35% border), the mode chip inset as a pill.
 */
import type { IntegrationStatus, MessageStatus } from '@/lib/domain/enums';
import { DEFAULT_TIMEZONE, formatDateTime } from '@/lib/format/date';
import { cn } from '@/components/ui/cn';
import { DELIVERY_STATUS_VOCABULARY, INTEGRATION_STATUS_VOCABULARY, TONE_CLASSES, type StatusEntry } from './status-vocabulary';

export function ModeChip({ simulated, className }: { simulated: boolean; className?: string }) {
  return (
    <span
      data-mode-chip={simulated ? 'simulated' : 'live'}
      className={cn(
        'inline-flex items-center rounded-full border px-1.5 text-[11px] leading-4 font-medium',
        simulated ? 'border-demo/40 bg-demo/12 text-demo' : 'border-border-strong bg-bg-2 text-fg-2',
        className,
      )}
    >
      {simulated ? 'Simulated' : 'Live'}
    </span>
  );
}

function Badge({ entry, simulated, suffix, detail, className }: { entry: StatusEntry; simulated: boolean; suffix?: string; detail?: boolean; className?: string }) {
  const Icon = entry.icon;
  const modeText = simulated ? 'Simulated' : 'Live';
  return (
    <span className={cn('inline-flex flex-col gap-1', className)}>
      <span
        data-status-badge
        data-tone={entry.tone}
        role="img"
        aria-label={`${entry.label}${suffix ? ` ${suffix}` : ''}, ${modeText}`}
        className={cn('inline-flex w-fit items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-2 text-xs font-medium', TONE_CLASSES[entry.tone])}
      >
        <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', entry.spinning && 'motion-safe:animate-spin')} />
        <span data-status-label>{entry.label}</span>
        {suffix ? <span className="text-fg-2">{suffix}</span> : null}
        <ModeChip simulated={simulated} />
      </span>
      {detail && entry.detail ? <span className="text-xs text-fg-2">{entry.detail}</span> : null}
    </span>
  );
}

export function IntegrationStatusBadge(props: {
  status: IntegrationStatus;
  simulated: boolean;
  /** Last successful check; shown as "· checked <time>" for CONNECTED. */
  checkedAt?: Date | null;
  timeZone?: string;
  showDetail?: boolean;
  className?: string;
}) {
  const entry = INTEGRATION_STATUS_VOCABULARY[props.status];
  const suffix =
    props.status === 'CONNECTED' && props.checkedAt ? `· checked ${formatDateTime(props.checkedAt, props.timeZone ?? DEFAULT_TIMEZONE)}` : undefined;
  return <Badge entry={entry} simulated={props.simulated} suffix={suffix} detail={props.showDetail} className={props.className} />;
}

export function DeliveryStatusBadge(props: { status: MessageStatus; simulated: boolean; showDetail?: boolean; className?: string }) {
  return <Badge entry={DELIVERY_STATUS_VOCABULARY[props.status]} simulated={props.simulated} detail={props.showDetail} className={props.className} />;
}
