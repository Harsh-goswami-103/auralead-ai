/**
 * Masked credentials (plan §9 "masked reads (last 4 + updatedAt), no reveal endpoint"; ADR-25).
 * Each credential field shows only whether it is saved, its last four characters when the server
 * stored them, and when it was saved. The server never sends more, and there is no control that
 * could reveal a value. Server-safe.
 */
import { KeyRound, LockKeyhole } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { formatDateTime } from '@/lib/format/date';

export type MaskedCredentialItem = { field: string; label: string; saved: boolean; last4: string | null; updatedAt: Date | null };

export function MaskedCredentials({ items, timeZone, className }: { items: MaskedCredentialItem[]; timeZone: string; className?: string }) {
  return (
    <dl className={cn('flex flex-col gap-2', className)}>
      {items.map((c) => (
        <div key={c.field} data-credential={c.field} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-border-subtle bg-bg-2/50 px-3 py-2">
          <dt className="flex min-w-0 items-center gap-2 text-sm text-fg-2">
            <KeyRound aria-hidden="true" className="size-4 shrink-0 text-fg-3" />
            {c.label}
          </dt>
          <dd className="flex items-center gap-2 text-sm">
            {c.saved ? (
              <>
                <LockKeyhole aria-hidden="true" className="size-3.5 text-success" />
                <span className="font-mono text-fg-1">{c.last4 ? `•••• ${c.last4}` : '••••'}</span>
                <span className="text-xs text-fg-2">{c.updatedAt ? `Saved ${formatDateTime(c.updatedAt, timeZone)}` : 'Saved, encrypted'}</span>
              </>
            ) : (
              <span className="text-fg-2">Not saved</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
