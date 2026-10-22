'use client';

/**
 * The Sheets column mapping editor (T34; plan §5.3, P1, PRD "config, validation, mapping, preview").
 * Row 1 is read from the Sheet by the server ("Load columns from the Sheet"), never typed in; each
 * lead field, the submission time and the WhatsApp/email consent question (with the answers that
 * mean yes and the notice text exactly as the form shows it) are mapped to a column. "Preview rows"
 * asks the server for a dry run of the next rows with this mapping and shows per row what would
 * happen; nothing is written. "Confirm mapping" saves it as the new active version: the server
 * re-reads the header and refuses a mapping made for other columns. A drifted header is shown as a
 * column diff. The browser checks only what it can (name and a contact column); the server judges.
 */
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, CircleCheck, Columns3, Eye, Save } from 'lucide-react';
import { LEAD_FIELD_LABELS, ROW_REASON_LABELS } from '@/components/integrations/vocabulary';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { cn } from '@/components/ui/cn';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import type { SheetsMappingInput } from '@/lib/schemas/sheets';
import { MAPPABLE_FIELDS } from '@/lib/schemas/webhooks/sources';

type HeaderResponse = { tab: string; columns: string[]; duplicates: string[]; hasEventIdColumn: boolean; headerFingerprint: string; activeVersion: number; drift: { added: string[]; removed: string[] } | null };
type PreviewRow = { rowNumber: number; outcome: 'CREATE' | 'MERGE' | 'REVIEW' | 'ALREADY_RECEIVED' | 'REJECT'; reasonCode: string | null; displayName: string | null; contacts: string[]; consent: string; weakId: boolean };
type PreviewResponse = { fromRow: number; rows: PreviewRow[]; counts: Record<PreviewRow['outcome'], number>; emptyRows: number[]; pendingRows: number[] };

export const PREVIEW_OUTCOME_LABELS: Readonly<Record<PreviewRow['outcome'], string>> = {
  CREATE: 'New lead',
  MERGE: 'Matches an existing lead',
  REVIEW: 'Needs review (matches several leads)',
  ALREADY_RECEIVED: 'Already received',
  REJECT: 'Rejected',
};

export const CONSENT_PREDICTION_LABELS: Readonly<Record<string, string>> = {
  WOULD_CAPTURE: 'Opt-in would be recorded',
  NO_MAPPING: 'No consent column mapped',
  COLUMN_MISSING: 'Consent answer missing',
  FALSY_VALUE: 'Answer is not a yes',
  NO_EVIDENCE_TIME: 'No submission time',
  NO_CONTACT_FOR_CHANNEL: 'No contact for the channel',
  PENDING_REVIEW: 'Decided after review',
  NOT_CAPTURED: 'Already received',
  REJECTED: 'Not recorded',
};

type Notice = { tone: 'success' | 'danger'; text: string } | null;

export function SheetsMappingEditor(props: { workspaceSlug: string; initial: SheetsMappingInput | null; activeVersion: number; gate: Gate | null }) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const ids = useId();
  const [header, setHeader] = useState<HeaderResponse | null>(null);
  const [fields, setFields] = useState<Record<string, string>>(() => ({ ...(props.initial?.fieldMap ?? {}) }));
  const [submittedAt, setSubmittedAt] = useState(props.initial?.submittedAtColumn ?? '');
  const [consentColumn, setConsentColumn] = useState(props.initial?.consent?.column ?? '');
  const [truthy, setTruthy] = useState((props.initial?.consent?.truthyValues ?? ['Yes']).join(', '));
  const [channel, setChannel] = useState<'WHATSAPP' | 'EMAIL'>(props.initial?.consent?.channel ?? 'WHATSAPP');
  const [purpose, setPurpose] = useState<'MARKETING' | 'SERVICE_CONVERSATION'>(props.initial?.consent?.purpose ?? 'MARKETING');
  const [notice, setNoticeText] = useState(props.initial?.consent?.noticeText ?? '');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [message, setMessage] = useState<Notice>(null);

  const columns = header?.columns ?? [...new Set([...Object.values(fields), submittedAt, consentColumn].filter((c) => c !== ''))];

  function mapping(): SheetsMappingInput {
    const fieldMap = Object.fromEntries(Object.entries(fields).filter(([, c]) => c !== '')) as SheetsMappingInput['fieldMap'];
    return {
      fieldMap,
      submittedAtColumn: submittedAt === '' ? null : submittedAt,
      consent:
        consentColumn === ''
          ? null
          : {
              column: consentColumn,
              truthyValues: truthy
                .split(',')
                .map((t) => t.trim())
                .filter((t) => t !== ''),
              channel,
              purpose,
              noticeText: notice.trim(),
            },
    };
  }

  function fail(res: { message: string; reference: string | null }) {
    setMessage({ tone: 'danger', text: `${res.message}${res.reference ? ` Reference ${res.reference}.` : ''}` });
  }

  async function loadColumns() {
    setMessage(null);
    const res = await postJson<HeaderResponse>('/api/app/sheets/header', { workspaceSlug: props.workspaceSlug }, csrf);
    if (!res.ok) return fail(res);
    setHeader(res.data);
    setPreview(null);
  }

  async function runPreview() {
    setMessage(null);
    const res = await postJson<PreviewResponse>('/api/app/sheets/preview', { workspaceSlug: props.workspaceSlug, mapping: mapping() }, csrf);
    if (!res.ok) return fail(res);
    setPreview(res.data);
  }

  async function confirm() {
    setMessage(null);
    if (!header) return;
    const res = await postJson<{ version: number }>('/api/app/sheets/mapping', { workspaceSlug: props.workspaceSlug, expectedVersion: props.activeVersion, headerFingerprint: header.headerFingerprint, mapping: mapping() }, csrf);
    if (!res.ok) return fail(res);
    setMessage({ tone: 'success', text: `Mapping version ${res.data.version} confirmed. Copy the Apps Script again: it carries the mapping version.` });
    router.refresh();
  }

  const select = (id: string, label: string, value: string, onChange: (v: string) => void, none = 'Not mapped') => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-fg-2">
        {label}
      </Label>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{none}</option>
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </NativeSelect>
    </div>
  );

  const nameOk = Boolean(fields.name);
  const contactOk = Boolean(fields.phone || fields.email);
  // An outer gate (mode, permission, configuration) is explained once, on "Load columns".
  const followGate: Gate | null = props.gate ? { category: props.gate.category, reason: 'Needs the columns from the Sheet (see above).' } : null;
  const localGate: Gate | null = !header ? { category: 'configuration', reason: 'Load the columns from the Sheet first.' } : !nameOk || !contactOk ? { category: 'configuration', reason: 'Map the name and a phone or email column.' } : null;

  return (
    <div data-mapping-editor className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <GatedAction label="Load columns from the Sheet" pendingLabel="Reading row 1..." variant="secondary" size="sm" icon={<Columns3 aria-hidden="true" />} gate={props.gate} onAction={loadColumns} />
        {header ? (
          <p className="text-xs text-fg-2">
            Tab “{header.tab}”: {header.columns.length} columns.{header.hasEventIdColumn ? ' The Apps Script’s id column is present.' : ' No auralead_event_id column yet (the script adds it).'}
          </p>
        ) : null}
      </div>
      {header?.drift ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-sm text-fg-1">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            The Sheet’s columns changed since mapping version {header.activeVersion}. Added: {header.drift.added.join(', ') || 'none'}. Removed: {header.drift.removed.join(', ') || 'none'}. Sync and pushes stay blocked until you confirm a mapping for the new columns.
          </span>
        </p>
      ) : null}
      {header && header.duplicates.length > 0 ? <p className="text-sm text-danger">Two columns share a name: {header.duplicates.join(', ')}. Rename one in the Sheet first.</p> : null}

      <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="mb-1 text-sm font-medium text-fg-1">Lead fields</legend>
        {MAPPABLE_FIELDS.map((f) => select(`${ids}-${f}`, LEAD_FIELD_LABELS[f] ?? f, fields[f] ?? '', (v) => setFields((prev) => ({ ...prev, [f]: v }))))}
        {select(`${ids}-submitted`, 'Submission time', submittedAt, setSubmittedAt)}
      </fieldset>

      <fieldset className="grid gap-3 rounded-lg border border-border-subtle bg-bg-2/50 p-3 sm:grid-cols-2">
        <legend className="px-1 text-sm font-medium text-fg-1">Consent question (P1)</legend>
        {select(`${ids}-consent`, 'Consent column', consentColumn, setConsentColumn, 'No consent question')}
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-truthy`} className="text-xs text-fg-2">
            Answers that mean yes
          </Label>
          <Input id={`${ids}-truthy`} value={truthy} onChange={(e) => setTruthy(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-channel`} className="text-xs text-fg-2">
            Channel
          </Label>
          <NativeSelect id={`${ids}-channel`} value={channel} onChange={(e) => setChannel(e.target.value as 'WHATSAPP' | 'EMAIL')}>
            <option value="WHATSAPP">WhatsApp</option>
            <option value="EMAIL">Email</option>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-purpose`} className="text-xs text-fg-2">
            Purpose
          </Label>
          <NativeSelect id={`${ids}-purpose`} value={purpose} onChange={(e) => setPurpose(e.target.value as 'MARKETING' | 'SERVICE_CONVERSATION')}>
            <option value="MARKETING">Marketing</option>
            <option value="SERVICE_CONVERSATION">Service conversation</option>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <Label htmlFor={`${ids}-notice`} className="text-xs text-fg-2">
            Notice text shown on the form
          </Label>
          <Textarea id={`${ids}-notice`} rows={2} value={notice} onChange={(e) => setNoticeText(e.target.value)} />
          <p className="text-xs text-fg-2">Stored verbatim and fingerprinted with every opt-in it records. A form submission without a yes to this question is never an opt-in.</p>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <GatedAction label="Preview rows" pendingLabel="Reading rows..." variant="secondary" size="sm" icon={<Eye aria-hidden="true" />} gate={followGate ?? (!nameOk || !contactOk ? localGate : null)} onAction={runPreview} />
        <GatedAction label="Confirm mapping" pendingLabel="Confirming..." size="sm" icon={<Save aria-hidden="true" />} gate={followGate ?? localGate} onAction={confirm} />
      </div>

      {message ? (
        <p role={message.tone === 'danger' ? 'alert' : 'status'} className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-sm text-fg-1', message.tone === 'danger' ? 'border-danger/35 bg-danger/10' : 'border-success/35 bg-success/10')}>
          {message.tone === 'danger' ? <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" /> : <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />}
          {message.text}
        </p>
      ) : null}

      {preview ? (
        <div className="flex flex-col gap-2" data-preview>
          <p className="text-xs text-fg-2">
            Dry run from row {preview.fromRow}: {preview.counts.CREATE} new, {preview.counts.MERGE} matching, {preview.counts.REVIEW} to review, {preview.counts.ALREADY_RECEIVED} already received, {preview.counts.REJECT} rejected. Nothing was written.
          </p>
          {preview.pendingRows.length > 0 ? <p className="text-xs text-fg-2">{`Row ${preview.pendingRows.join(', ')} is waiting for its auralead_event_id from the Apps Script; the sync reads it once the id is there.`}</p> : null}
          <div className="relative overflow-x-auto rounded-lg border border-border-subtle">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Preview of the next rows</caption>
              <thead className="bg-bg-2/60 text-xs text-fg-2">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Row
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Name
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Would
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Reason
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Consent
                  </th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.rowNumber} data-preview-outcome={r.outcome} className="border-t border-border-subtle">
                    <td className="px-3 py-2 font-mono text-xs text-fg-2">{r.rowNumber}</td>
                    <td className="px-3 py-2 text-fg-1">{r.displayName ?? '—'}</td>
                    <td className="px-3 py-2 text-fg-1">
                      <span className="inline-flex items-center gap-1.5">
                        {r.outcome === 'REJECT' ? <CircleAlert aria-hidden="true" className="size-3.5 text-danger" /> : <CircleCheck aria-hidden="true" className="size-3.5 text-success" />}
                        {PREVIEW_OUTCOME_LABELS[r.outcome]}
                      </span>
                      {r.weakId ? <span className="ml-1 text-xs text-warning">(identified by content)</span> : null}
                    </td>
                    <td className="px-3 py-2 text-fg-2">{r.reasonCode ? (ROW_REASON_LABELS[r.reasonCode] ?? r.reasonCode) : '—'}</td>
                    <td className="px-3 py-2 text-fg-2">{CONSENT_PREDICTION_LABELS[r.consent] ?? r.consent}</td>
                  </tr>
                ))}
                {preview.rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-2 text-fg-2">
                      No new rows after the last sync.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
