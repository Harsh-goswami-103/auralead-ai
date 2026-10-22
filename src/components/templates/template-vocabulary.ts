/**
 * Words and status chips of the template studio (ADR-123, slice F4). Status is always icon plus
 * label (06-design F2): the studio's own states (Draft, Submitting) and Meta's raw statuses, named
 * in plain words for the common ones and shown verbatim otherwise. Pure data, shared by server and
 * client components.
 */
import { CircleCheck, CircleDashed, CircleSlash, Clock, LoaderCircle, PauseCircle, PencilLine } from 'lucide-react';
import { rawStatusEntry, type RawStatusEntry } from '@/components/integrations/vocabulary';
import { TEMPLATE_VARIABLE_SOURCES, type TemplateVariableSource } from '@/lib/domain/whatsapp-templates';

export function templateStatusEntry(status: string): RawStatusEntry {
  const value = status.trim().toUpperCase();
  switch (value) {
    case 'DRAFT':
      return { label: 'Draft', tone: 'neutral', icon: PencilLine };
    case 'SUBMITTING':
      return { label: 'Submitting to Meta', tone: 'info', icon: LoaderCircle };
    case 'PENDING':
      return { label: 'Pending review', tone: 'warning', icon: Clock };
    case 'APPROVED':
      return { label: 'Approved', tone: 'success', icon: CircleCheck };
    case 'REJECTED':
      return { label: 'Rejected', tone: 'danger', icon: CircleSlash };
    case 'PAUSED':
      return { label: 'Paused by Meta', tone: 'warning', icon: PauseCircle };
    case 'DISABLED':
      return { label: 'Disabled by Meta', tone: 'danger', icon: CircleSlash };
    case 'IN_APPEAL':
      return { label: 'In appeal', tone: 'warning', icon: Clock };
    default:
      return value === '' ? { label: 'Unknown', tone: 'neutral', icon: CircleDashed } : rawStatusEntry(status);
  }
}

/** The sources the body's variable buttons insert (lead and workspace facts, filled per lead at send time). */
export const INSERTABLE_SOURCES: ReadonlyArray<{ source: TemplateVariableSource; label: string }> = [
  { source: 'lead.firstName', label: 'First name' },
  { source: 'lead.displayName', label: 'Customer name' },
  { source: 'lead.city', label: 'City' },
  { source: 'lead.category', label: 'Business category' },
  { source: 'workspace.name', label: 'Your business name' },
];

/** Every source a variable may be mapped to, with its label (the select in the variables table). */
export const SOURCE_OPTIONS: ReadonlyArray<{ source: TemplateVariableSource; label: string }> = (Object.keys(TEMPLATE_VARIABLE_SOURCES) as TemplateVariableSource[]).map((source) => ({
  source,
  label: TEMPLATE_VARIABLE_SOURCES[source],
}));

export const HEADER_FORMAT_LABELS: Readonly<Record<'NONE' | 'TEXT' | 'DOCUMENT', string>> = { NONE: 'No header', TEXT: 'Text', DOCUMENT: 'PDF document' };

export const BUTTON_TYPE_LABELS: Readonly<Record<'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER', string>> = { QUICK_REPLY: 'Quick reply', URL: 'Website link', PHONE_NUMBER: 'Call button' };
