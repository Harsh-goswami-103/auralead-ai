/**
 * Words and status looks of the lead import (ADR-120): status is an icon plus a label, the counts
 * are named the way the lead console names ingestion outcomes. Pure data, shared by server and
 * client components.
 */
import { CircleCheck, CircleSlash, Clock3, FileSearch, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { StatusTone } from '@/components/patterns/status-vocabulary';
import type { LeadImportStatus } from '@/lib/domain/enums';

export const IMPORT_STATUS: Readonly<Record<LeadImportStatus, { label: string; tone: StatusTone; icon: LucideIcon; spinning?: boolean }>> = {
  PREVIEW: { label: 'Waiting for your mapping', tone: 'info', icon: FileSearch },
  QUEUED: { label: 'Queued', tone: 'info', icon: Clock3 },
  RUNNING: { label: 'Importing', tone: 'info', icon: LoaderCircle, spinning: true },
  SUCCEEDED: { label: 'Finished', tone: 'success', icon: CircleCheck },
  FAILED: { label: 'Failed', tone: 'danger', icon: TriangleAlert },
  EXPIRED: { label: 'Expired', tone: 'neutral', icon: CircleSlash },
};

export const IMPORT_COUNT_LABELS = {
  accepted: 'New leads',
  duplicates: 'Already in your leads',
  review: 'Sent to duplicate review',
  rejected: 'Not imported',
  consentRecorded: 'WhatsApp opt-ins recorded',
} as const;

/** Why a consent column was not honoured (the confirm answer's reason). */
export const CONSENT_DECISION_LABELS: Readonly<Record<string, string>> = {
  NOT_REQUESTED: 'No consent was imported: the attestation was not given, so the opt-in column was ignored.',
  NO_CAPABILITY: 'No consent was imported: only the workspace owner can import WhatsApp opt-ins.',
  DATA_SOURCE_NOT_OWN: 'No consent was imported: opt-ins are honoured only for lists the business collected itself.',
};
