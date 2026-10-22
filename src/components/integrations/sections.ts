/**
 * The sections of one assigned workspace (T28; 06-design §11.2 route map), shared by the section
 * tabs and the assignment overview. A plain module (not a client module), so server components can
 * read the list.
 *
 * Lead-gen suite (docs/handoff/lead-gen-suite-plan.md §6): a slice adds its section together with
 * its page, inside its own block (a nav target must exist: tests/unit/arch/route-manifest.test.ts),
 * and imports its icon inside its own block above.
 */
import { ClipboardCheck, FileSpreadsheet, MapPin, Megaphone, Plug, Users, Workflow, type LucideIcon } from 'lucide-react';
// ---- lead-gen F1 finder ----

// ---- end F1 ----
// ---- lead-gen F2 import ----

// ---- end F2 ----
// ---- lead-gen F3 chat ----
import { MessageCircle } from 'lucide-react';
// ---- end F3 ----
// ---- lead-gen F4 templates ----

// ---- end F4 ----
// ---- lead-gen F5 handoff ----

// ---- end F5 ----
// ---- lead-gen F6 presentation ----

// ---- end F6 ----

export const WORKSPACE_SECTIONS: ReadonlyArray<{ segment: string; label: string; icon: LucideIcon }> = [
  { segment: 'leads', label: 'Leads', icon: Users },
  { segment: 'approvals', label: 'Approvals', icon: ClipboardCheck },
  { segment: 'integrations', label: 'Integrations', icon: Plug },
  { segment: 'pipeline', label: 'Pipeline', icon: Workflow },
  { segment: 'sheets', label: 'Sheets', icon: FileSpreadsheet },
  { segment: 'meta', label: 'Meta', icon: Megaphone },
  { segment: 'extension', label: 'Extension', icon: MapPin },
  // ---- lead-gen F1 finder ----

  // ---- end F1 ----
  // ---- lead-gen F2 import ----

  // ---- end F2 ----
  // ---- lead-gen F3 chat ----
  { segment: 'inbox', label: 'Inbox', icon: MessageCircle },
  // ---- end F3 ----
  // ---- lead-gen F4 templates ----

  // ---- end F4 ----
  // ---- lead-gen F5 handoff ----

  // ---- end F5 ----
  // ---- lead-gen F6 presentation ----

  // ---- end F6 ----
];

export function workspaceSectionHref(slug: string, segment: string): string {
  return `/dashboard/employee/${encodeURIComponent(slug)}/${segment}`;
}
