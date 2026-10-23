/**
 * "Needs you" (06-design §11.1): the items waiting for a person, each a stored count with its
 * definition under the label and a link to the page where it is handled. Lines with something
 * waiting come first as rows (icon + label + count, never color alone); lines with nothing
 * waiting are listed once in a quiet "Nothing waiting" sentence, so the card stays short and still
 * says what was checked. Server-safe.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, CircleAlert, CircleCheck, CircleHelp, ClipboardCheck, Hand, Handshake, MessageSquareDashed, PhoneCall, Undo2, type LucideIcon } from 'lucide-react';
import { TONE_CLASSES, type StatusTone } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';

export type NeedsYouLine = {
  id: string;
  label: string;
  definition: string;
  href: string | null;
  tone: 'attention' | 'problem' | 'info';
  count: number;
};

const ICONS: Readonly<Record<string, LucideIcon>> = {
  quoteApprovals: ClipboardCheck,
  messageApprovals: MessageSquareDashed,
  invalidatedApprovals: Undo2,
  failedDeliveries: CircleAlert,
  unknownDeliveries: CircleHelp,
  takeoverThreads: Hand,
  openCallRequests: PhoneCall,
  handedOverLeads: Handshake,
};

const TONES: Readonly<Record<NeedsYouLine['tone'], StatusTone>> = { attention: 'warning', problem: 'danger', info: 'info' };

function Row(props: { line: NeedsYouLine; children: ReactNode }) {
  const { line } = props;
  const body = (
    <>
      {props.children}
      {line.href ? <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-fg-3 transition-transform duration-fast group-hover:text-panel motion-safe:group-hover:translate-x-0.5" /> : null}
    </>
  );
  const shape = 'group flex items-start gap-3 rounded-lg border border-border-subtle bg-bg-2/40 px-3 py-2.5';
  return (
    <li>
      {line.href ? (
        <Link href={line.href} className={cn(shape, 'transition-colors duration-fast hover:border-panel/45 hover:bg-bg-2/70')}>
          {body}
        </Link>
      ) : (
        <div className={shape}>{body}</div>
      )}
    </li>
  );
}

export function NeedsYouList(props: { items: NeedsYouLine[] }) {
  const waiting = props.items.filter((i) => i.count > 0);
  const clear = props.items.filter((i) => i.count === 0);
  return (
    <div className="flex flex-col gap-3">
      {waiting.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {waiting.map((line) => {
            const Icon = ICONS[line.id] ?? CircleAlert;
            return (
              <Row key={line.id} line={line}>
                <span aria-hidden="true" className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border [&>svg]:size-4', TONE_CLASSES[TONES[line.tone]])}>
                  <Icon />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="font-medium text-fg-1">{line.label}</span>{' '}
                    <span className="tabular font-display text-lg font-semibold text-fg-1">{line.count.toLocaleString('en-IN')}</span>
                  </span>{' '}
                  <span className="text-xs text-fg-2">{line.definition}</span>
                </span>
              </Row>
            );
          })}
        </ul>
      ) : (
        <p className="flex items-center gap-2 rounded-lg border border-success/35 bg-success/8 px-3 py-2.5 text-sm text-fg-1">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success" />
          Nothing needs you right now.
        </p>
      )}
      {clear.length > 0 && waiting.length > 0 ? (
        <p className="flex items-start gap-2 text-xs text-fg-2">
          <CircleCheck aria-hidden="true" className="mt-px size-3.5 shrink-0 text-success" />
          <span>Nothing waiting: {clear.map((c) => c.label.replace(/ \(7 days\)$/, '').toLowerCase()).join(', ')}.</span>
        </p>
      ) : null}
      {waiting.length === 0 ? <p className="text-xs text-fg-2">Checked: {clear.map((c) => c.label.toLowerCase()).join(', ')}.</p> : null}
    </div>
  );
}
