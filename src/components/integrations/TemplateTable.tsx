/**
 * Synced WhatsApp templates (T28, T32; ADR-17, P12): name, language, the raw category and status
 * strings exactly as WhatsApp Manager reports them (status as icon + the raw label), the intent each
 * template is mapped to, its positional variables, whether this app can send it, and the sync
 * time. With `integrations.manage` each row opens its mapping form (intent, variable sources,
 * quick-reply buttons). Templates are authored and approved in WhatsApp Manager, never here. The
 * table scrolls inside its card. Server-safe (the mapping form is a client island).
 */
import { formatDateTime } from '@/lib/format/date';
import { StatusChip } from './StatusChip';
import { TemplateMappingForm } from './TemplateMappingForm';
import { INTENT_LABELS, rawStatusEntry } from './vocabulary';

export type TemplateRow = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  intent: string | null;
  variables: string[];
  syncedAt: Date;
  sources?: Record<string, string>;
  quickReplies?: Array<{ index: number; text: string; intent: string | null }>;
  notSendable?: string | null;
};

export function TemplateTable({ templates, timeZone, mapping }: { templates: TemplateRow[]; timeZone: string; mapping?: { workspaceSlug: string } | null }) {
  return (
    <div className="relative overflow-x-auto rounded-lg border border-border-subtle">
      <table className="w-full min-w-[40rem] text-left text-sm">
        <caption className="sr-only">Synced WhatsApp templates</caption>
        <thead className="bg-bg-2/60 text-xs text-fg-2">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Template
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Status
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Category
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Used for
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Variables
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Synced
            </th>
          </tr>
        </thead>
        <tbody>
          {templates.map((t) => (
            <tr key={t.id} data-template={t.name} className="border-t border-border-subtle align-top">
              <th scope="row" className="px-3 py-2 font-normal">
                <span className="font-mono text-fg-1">{t.name}</span> <span className="text-xs text-fg-2">({t.language})</span>
                {t.notSendable ? <span className="mt-1 block text-xs text-warning">Not sendable from here: {t.notSendable}.</span> : null}
                {mapping ? (
                  <details className="mt-2 max-w-sm">
                    <summary className="cursor-pointer text-xs font-medium text-cyan underline-offset-4 hover:underline">Edit mapping</summary>
                    <div className="mt-2">
                      <TemplateMappingForm
                        workspaceSlug={mapping.workspaceSlug}
                        template={{ id: t.id, name: t.name, intent: t.intent, variables: t.variables, sources: t.sources ?? {}, quickReplies: t.quickReplies ?? [] }}
                      />
                    </div>
                  </details>
                ) : null}
              </th>
              <td className="px-3 py-2">
                <StatusChip entry={rawStatusEntry(t.status)} />
              </td>
              <td className="px-3 py-2 font-mono text-xs text-fg-1">{t.category}</td>
              <td className="px-3 py-2 text-fg-1">{t.intent ? (INTENT_LABELS[t.intent] ?? t.intent) : <span className="text-fg-2">Not mapped</span>}</td>
              <td className="px-3 py-2 text-fg-1">{t.variables.length === 0 ? <span className="text-fg-2">None</span> : t.variables.map((v) => `{{${v}}}`).join(' ')}</td>
              <td className="px-3 py-2 text-xs whitespace-nowrap text-fg-2">{formatDateTime(t.syncedAt, timeZone)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
