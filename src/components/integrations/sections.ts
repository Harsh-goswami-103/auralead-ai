/**
 * The sections of one assigned workspace (T28; 06-design §11.2 route map), shared by the section
 * tabs and the assignment overview. A plain module (not a client module), so server components can
 * read the list.
 */
import { ClipboardCheck, FileSpreadsheet, MapPin, Megaphone, Plug, Users, Workflow, type LucideIcon } from 'lucide-react';

export const WORKSPACE_SECTIONS: ReadonlyArray<{ segment: string; label: string; icon: LucideIcon }> = [
  { segment: 'leads', label: 'Leads', icon: Users },
  { segment: 'approvals', label: 'Approvals', icon: ClipboardCheck },
  { segment: 'integrations', label: 'Integrations', icon: Plug },
  { segment: 'pipeline', label: 'Pipeline', icon: Workflow },
  { segment: 'sheets', label: 'Sheets', icon: FileSpreadsheet },
  { segment: 'meta', label: 'Meta', icon: Megaphone },
  { segment: 'extension', label: 'Extension', icon: MapPin },
];

export function workspaceSectionHref(slug: string, segment: string): string {
  return `/dashboard/employee/${encodeURIComponent(slug)}/${segment}`;
}
