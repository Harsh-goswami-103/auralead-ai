/**
 * Words and icons of the Meta console's live parts (T35): CampaignAction and backfill states,
 * always icon plus label (06-design F2), and the failure codes in plain words. Browser-safe.
 */
import { CircleAlert, CircleCheck, CircleHelp, Clock, FlaskConical, LoaderCircle } from 'lucide-react';
import type { RawStatusEntry } from '@/components/integrations/vocabulary';

export type ActionState = 'PENDING' | 'SENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'SIMULATED';

export const ACTION_STATE: Readonly<Record<ActionState, RawStatusEntry>> = {
  PENDING: { label: 'Queued for Meta', tone: 'info', icon: Clock },
  SENDING: { label: 'Sending to Meta', tone: 'info', icon: LoaderCircle },
  SUCCEEDED: { label: 'Confirmed by Meta', tone: 'success', icon: CircleCheck },
  FAILED: { label: 'Failed, nothing changed', tone: 'danger', icon: CircleAlert },
  UNKNOWN: { label: 'Unknown, confirming with Meta', tone: 'warning', icon: CircleHelp },
  SIMULATED: { label: 'Simulated', tone: 'demo', icon: FlaskConical },
};

export const BACKFILL_STATE: Readonly<Record<string, RawStatusEntry>> = {
  QUEUED: { label: 'Queued', tone: 'info', icon: Clock },
  RUNNING: { label: 'Reading leads', tone: 'info', icon: LoaderCircle },
  COMPLETED: { label: 'Completed', tone: 'success', icon: CircleCheck },
  FAILED: { label: 'Failed', tone: 'danger', icon: CircleAlert },
};

export const META_FAILURE_LABELS: Readonly<Record<string, string>> = {
  PROVIDER_AUTH: 'Meta rejected the access token: verification required',
  PERMISSION_MISSING: 'A permission is missing',
  CREDENTIAL_UNREADABLE: 'Credential unreadable, re-enter',
  INTEGRATION_NOT_CONFIGURED: 'Meta Lead Ads is not configured',
  INTEGRATION_NOT_VERIFIED: 'Meta Lead Ads is not verified',
  MAPPING_NOT_FOUND: 'The form has no field mapping',
  LEAD_UNRETRIEVABLE: 'Meta did not return the lead',
  PROVIDER_RATE_LIMITED: 'Meta rate limited the requests',
  PROVIDER_UNAVAILABLE: 'Meta answered with a server error',
  PROVIDER_UNREACHABLE: 'Meta could not be reached',
  PROVIDER_REJECTED: 'Meta rejected the request',
  WRITE_TIMEOUT: 'No answer after the request was sent',
  READBACK_NOT_APPLIED: 'Meta shows the change did not apply',
  READBACK_FAILED: 'The status could not be read back',
  CAMPAIGN_NOT_FOUND: 'Meta does not know this campaign',
  CONFIG_INVALID: 'Meta did not accept a configured ID',
};

export function failureLabel(code: string | null): string {
  if (code === null) return '';
  return META_FAILURE_LABELS[code] ?? 'See the message below';
}

/** A fresh client request key (8-64 of A-Z a-z 0-9 _ -), reused on retry so one click is one action. */
export function newRequestKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
