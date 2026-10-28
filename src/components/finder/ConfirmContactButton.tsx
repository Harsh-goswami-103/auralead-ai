'use client';

/**
 * "Confirm details" for a lead imported from Google Places (ADR-118 (d), slice F1): the operator
 * records that the business confirmed its contact details, so the Places-sourced fields are kept
 * past their 30-day expiry. Shows when the details expire, or that they were confirmed (and how).
 * Posts once with the CSRF header; without `leads.write` the button stays focusable and says why.
 * For the lead pages (wired by the integrator).
 */
import { useRouter } from 'next/navigation';
import { BadgeCheck, CalendarClock } from 'lucide-react';
import { toast } from 'sonner';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { formatDate } from '@/lib/format/date';
import { CONTACT_CONFIRMED_VIA_LABELS, type ContactConfirmedVia } from '@/lib/domain/lead-gen';

export function ConfirmContactButton(props: {
  leadId: string;
  workspaceSlug?: string;
  placesContentExpiresAt: string | null;
  contactConfirmedAt: string | null;
  contactConfirmedVia: string | null;
  timeZone: string;
  gate: Gate | null;
}) {
  const router = useRouter();
  const csrfToken = useCsrfToken();

  if (props.contactConfirmedAt) {
    const via = props.contactConfirmedVia && props.contactConfirmedVia in CONTACT_CONFIRMED_VIA_LABELS ? CONTACT_CONFIRMED_VIA_LABELS[props.contactConfirmedVia as ContactConfirmedVia] : 'Confirmed';
    return (
      <p data-contact-confirmed="" className="inline-flex items-center gap-1.5 text-sm text-fg-1">
        <BadgeCheck aria-hidden="true" className="size-4 text-success" />
        Contact details confirmed on {formatDate(new Date(props.contactConfirmedAt), props.timeZone)}: {via}.
      </p>
    );
  }
  if (!props.placesContentExpiresAt) return null;

  async function confirm() {
    const res = await postJson(`/api/app/leads/${encodeURIComponent(props.leadId)}/confirm-contact`, props.workspaceSlug ? { workspaceSlug: props.workspaceSlug } : {}, csrfToken);
    if (!res.ok) {
      toast.error(res.message, { description: res.reference ? `Reference: ${res.reference}` : undefined });
      return;
    }
    toast.success('Contact details confirmed.', { description: 'They are kept past the 30-day Google Places limit.' });
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <p className="inline-flex items-center gap-1.5 text-sm text-fg-2">
        <CalendarClock aria-hidden="true" className="size-4 text-fg-3" />
        Phone, rating, reviews, address, PIN code and category came from Google Places and are removed on {formatDate(new Date(props.placesContentExpiresAt), props.timeZone)} unless the business confirms them.
      </p>
      <GatedAction label="Confirm details" pendingLabel="Confirming..." variant="outline" size="sm" icon={<BadgeCheck aria-hidden="true" />} gate={props.gate} onAction={confirm} />
    </div>
  );
}
