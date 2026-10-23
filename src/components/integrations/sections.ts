/**
 * The sections of one assigned workspace (T28; 06-design §11.2 route map), shared by the section
 * tabs and the assignment overview. A plain module (not a client module), so server components can
 * read the list.
 *
 * Lead-gen suite (docs/handoff/lead-gen-suite-plan.md §6): a slice adds its section together with
 * its page, inside its own block (a nav target must exist: tests/unit/arch/route-manifest.test.ts),
 * and imports its icon inside its own block above. The blocks sit in slice order only so that the
 * merges never meet; what the operator sees is `WORKSPACE_SECTIONS`, which puts the entries in the
 * order of the story (SECTION_ORDER below): Lead finder, Leads, Inbox, Templates, Approvals, then
 * the setup sections.
 */
import { ClipboardCheck, FileSpreadsheet, MapPin, Megaphone, Plug, Users, Workflow, type LucideIcon } from 'lucide-react';
// ---- lead-gen F1 finder ----
import { ScanSearch } from 'lucide-react';
// ---- end F1 ----
// ---- lead-gen F2 import ----

// ---- end F2 ----
// ---- lead-gen F3 chat ----
import { MessageCircle } from 'lucide-react';
// ---- end F3 ----
// ---- lead-gen F4 templates ----
import { MessageSquareText } from 'lucide-react';
// ---- end F4 ----
// ---- lead-gen F5 handoff ----

// ---- end F5 ----
// ---- lead-gen F6 presentation ----

// ---- end F6 ----

type WorkspaceSection = { segment: string; label: string; icon: LucideIcon };

const SECTION_ENTRIES: ReadonlyArray<WorkspaceSection> = [
  { segment: 'leads', label: 'Leads', icon: Users },
  { segment: 'approvals', label: 'Approvals', icon: ClipboardCheck },
  { segment: 'integrations', label: 'Integrations', icon: Plug },
  { segment: 'pipeline', label: 'Pipeline', icon: Workflow },
  { segment: 'sheets', label: 'Sheets', icon: FileSpreadsheet },
  { segment: 'meta', label: 'Meta', icon: Megaphone },
  { segment: 'extension', label: 'Extension', icon: MapPin },
  // ---- lead-gen F1 finder ----
  { segment: 'finder', label: 'Lead finder', icon: ScanSearch },
  // ---- end F1 ----
  // ---- lead-gen F2 import ----

  // ---- end F2 ----
  // ---- lead-gen F3 chat ----
  { segment: 'inbox', label: 'Inbox', icon: MessageCircle },
  // ---- end F3 ----
  // ---- lead-gen F4 templates ----
  { segment: 'templates', label: 'Templates', icon: MessageSquareText },
  // ---- end F4 ----
  // ---- lead-gen F5 handoff ----

  // ---- end F5 ----
  // ---- lead-gen F6 presentation ----

  // ---- end F6 ----
];

/**
 * The order the operator walks the product in (the presentation story): find businesses, work the
 * leads, talk to them, send templates, approve, then the setup sections. A section that is not
 * listed here keeps its place after the listed ones, in the order of SECTION_ENTRIES.
 */
export const SECTION_ORDER: ReadonlyArray<string> = ['finder', 'leads', 'inbox', 'templates', 'approvals', 'integrations', 'pipeline', 'sheets', 'meta', 'extension'];

function inStoryOrder(entries: ReadonlyArray<WorkspaceSection>): ReadonlyArray<WorkspaceSection> {
  const rank = (segment: string) => {
    const i = SECTION_ORDER.indexOf(segment);
    return i === -1 ? SECTION_ORDER.length : i;
  };
  // Array.prototype.sort is stable: unlisted sections keep their relative order.
  return [...entries].sort((a, b) => rank(a.segment) - rank(b.segment));
}

export const WORKSPACE_SECTIONS: ReadonlyArray<WorkspaceSection> = inStoryOrder(SECTION_ENTRIES);

export function workspaceSectionHref(slug: string, segment: string): string {
  return `/dashboard/employee/${encodeURIComponent(slug)}/${segment}`;
}
