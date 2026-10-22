'use client';

/**
 * Step 2 of the lead import (ADR-120): the person checks the column mapping (suggested from the
 * header names), sees the first 20 rows, says where the list came from and confirms. A business
 * name column and a phone or email column are required (the server checks again). A column fills
 * one field: choosing it for a second field clears the first.
 *
 * The consent section is shown to an owner with consent.import only. Its opt-in columns are sent
 * only when the person ticks the attestation, whose text is shown and sent verbatim; without the
 * tick the opt-in column is ignored and no consent is recorded. The server applies every other
 * ADR-120 rule (own data source, a notice naming the business and WhatsApp, no future dates).
 */
import { useId, useState } from 'react';
import { ShieldCheck, TriangleAlert, Upload } from 'lucide-react';
import { postJson } from '@/components/patterns/api-client';
import { GatedAction } from '@/components/patterns/GatedAction';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/components/ui/cn';
import { ImportDataSource } from '@/lib/domain/enums';
import {
  columnLabel,
  IMPORT_DATA_SOURCE_LABELS,
  IMPORT_FIELD_LABELS,
  IMPORT_LEAD_FIELDS,
  isOwnDataSource,
  noticeProblems,
  type ConsentDecision,
  type ImportField,
  type ImportMappingValue,
  type LeadImportDto,
  type LeadImportView,
} from '@/lib/schemas/lead-import';

export type ConsentProps = { allowed: boolean; noticeDefault: string; attestationText: string; businessName: string };

type Failure = { message: string; reference: string | null } | null;

/** What blocks the confirm button, as the person would fix it. */
export function mappingProblems(mapping: ImportMappingValue, dataSource: string): string[] {
  const problems: string[] = [];
  if (mapping.name === undefined) problems.push('Choose the column with the business name.');
  if (mapping.phone === undefined && mapping.email === undefined) problems.push('Choose a phone or an email column.');
  if (dataSource === '') problems.push('Say where this list came from.');
  return problems;
}

function FieldSelect(props: { field: ImportField; header: string[]; mapping: ImportMappingValue; onChange: (field: ImportField, col: number | undefined) => void; required?: boolean }) {
  const id = useId();
  const value = props.mapping[props.field];
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-fg-2">
        {IMPORT_FIELD_LABELS[props.field]}
        {props.required ? <span className="text-fg-3"> (required)</span> : null}
      </Label>
      <NativeSelect id={id} data-field={props.field} value={value === undefined ? '' : String(value)} onChange={(e) => props.onChange(props.field, e.target.value === '' ? undefined : Number(e.target.value))}>
        <option value="">Not imported</option>
        {props.header.map((h, i) => (
          <option key={i} value={i}>
            {columnLabel(i, h)}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function PreviewTable(props: { view: LeadImportView; mapping: ImportMappingValue }) {
  const preview = props.view.preview!;
  const fieldOf = new Map<number, ImportField>();
  for (const [field, col] of Object.entries(props.mapping)) fieldOf.set(col, field as ImportField);
  return (
    <div className="overflow-x-auto rounded-lg border border-border-subtle">
      <table className="min-w-full text-left text-sm">
        <caption className="sr-only">
          The first {preview.rows.length} rows of {props.view.import.fileName}
        </caption>
        <thead className="bg-bg-2 text-xs text-fg-2">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Row
            </th>
            {preview.header.map((h, i) => {
              const field = fieldOf.get(i);
              return (
                <th key={i} scope="col" data-mapped={field ? 'true' : 'false'} className={cn('px-3 py-2 align-bottom font-medium whitespace-nowrap', field ? 'text-fg-1' : 'text-fg-3')}>
                  <span className="block">{columnLabel(i, h)}</span>
                  <span className="block text-[11px] font-normal">{field ? `Imported as ${IMPORT_FIELD_LABELS[field]}` : 'Not imported'}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {preview.rows.map((r) => (
            <tr key={r.row}>
              <th scope="row" className="tabular px-3 py-1.5 font-normal text-fg-2">
                {r.row}
              </th>
              {r.cells.map((c, i) => (
                <td key={i} title={c} className={cn('max-w-56 truncate px-3 py-1.5', fieldOf.has(i) ? 'text-fg-1' : 'text-fg-3')}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConsentSection(props: {
  consent: ConsentProps;
  header: string[];
  mapping: ImportMappingValue;
  onField: (field: ImportField, col: number | undefined) => void;
  dataSource: string;
  notice: string;
  onNotice: (value: string) => void;
  attested: boolean;
  onAttested: (value: boolean) => void;
}) {
  const noticeId = useId();
  const attestId = useId();
  const problems = noticeProblems(props.notice, props.consent.businessName);
  const ownSource = props.dataSource === '' || isOwnDataSource(props.dataSource);
  return (
    <fieldset className="flex flex-col gap-4 rounded-lg border border-border-subtle bg-bg-2/40 p-4">
      <legend className="flex items-center gap-2 px-1 text-sm font-medium text-fg-1">
        <ShieldCheck aria-hidden="true" className="size-4 text-fg-2" />
        WhatsApp opt-ins in this file (optional)
      </legend>
      <p className="max-w-prose text-sm text-fg-2">
        Only for a list your business collected itself, where each person agreed to WhatsApp messages from {props.consent.businessName}. Rows marked as opted in get a recorded WhatsApp opt-in with
        your attestation. Anyone who replied STOP stays opted out.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldSelect field="consent" header={props.header} mapping={props.mapping} onChange={props.onField} />
        <FieldSelect field="consentDate" header={props.header} mapping={props.mapping} onChange={props.onField} />
      </div>
      {!ownSource ? (
        <p className="flex items-start gap-2 text-sm text-warning">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          Opt-ins are ignored for {IMPORT_DATA_SOURCE_LABELS[props.dataSource as ImportDataSource].toLowerCase()}.
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={noticeId} className="text-fg-2">
          The notice these people saw
        </Label>
        <Textarea id={noticeId} value={props.notice} onChange={(e) => props.onNotice(e.target.value)} rows={3} maxLength={5000} aria-describedby={`${noticeId}-hint`} />
        <p id={`${noticeId}-hint`} className="text-xs text-fg-2">
          It must name {props.consent.businessName} and WhatsApp.
          {problems.length > 0 ? <span className="text-warning"> {problems.includes('NOTICE_MISSING_BUSINESS') ? `Add "${props.consent.businessName}".` : ''} {problems.includes('NOTICE_MISSING_WHATSAPP') ? 'Add "WhatsApp".' : ''}</span> : null}
        </p>
      </div>
      <div className="flex items-start gap-3">
        <input id={attestId} type="checkbox" checked={props.attested} onChange={(e) => props.onAttested(e.target.checked)} className="mt-1 size-4 shrink-0 accent-[var(--accent)]" />
        <label htmlFor={attestId} className="text-sm text-fg-1">
          {props.consent.attestationText}
        </label>
      </div>
    </fieldset>
  );
}

export function MappingStep(props: {
  view: LeadImportView;
  workspaceSlug: string;
  csrfToken: string | null;
  consent: ConsentProps;
  onConfirmed: (dto: LeadImportDto, consent: ConsentDecision) => void;
  onStartOver: () => void;
}) {
  const preview = props.view.preview!;
  const [mapping, setMapping] = useState<ImportMappingValue>(() => {
    const suggested = { ...preview.suggestedMapping };
    if (!props.consent.allowed) {
      delete suggested.consent;
      delete suggested.consentDate;
    }
    return suggested;
  });
  const [dataSource, setDataSource] = useState<string>('');
  const [notice, setNotice] = useState(props.consent.noticeDefault);
  const [attested, setAttested] = useState(false);
  const [failure, setFailure] = useState<Failure>(null);
  const sourceId = useId();

  function setField(field: ImportField, col: number | undefined) {
    setMapping((current) => {
      const next: ImportMappingValue = {};
      for (const [f, c] of Object.entries(current) as Array<[ImportField, number]>) if (f !== field && c !== col) next[f] = c;
      if (col !== undefined) next[field] = col;
      return next;
    });
  }

  const problems = mappingProblems(mapping, dataSource);
  const sendConsent = props.consent.allowed && attested && mapping.consent !== undefined;

  async function confirm() {
    if (problems.length > 0) {
      setFailure({ message: problems.join(' '), reference: null });
      return;
    }
    setFailure(null);
    const full = Object.fromEntries([...IMPORT_LEAD_FIELDS, 'consent', 'consentDate'].map((f) => [f, mapping[f as ImportField] ?? null]));
    const res = await postJson<{ import: LeadImportDto; consent: ConsentDecision }>(
      `/api/app/leads/imports/${encodeURIComponent(props.view.import.id)}/confirm`,
      {
        workspaceSlug: props.workspaceSlug,
        mapping: full,
        ...(dataSource ? { dataSource } : {}),
        ...(sendConsent ? { consent: { noticeText: notice, attestation: props.consent.attestationText } } : {}),
      },
      props.csrfToken,
    );
    if (!res.ok) {
      setFailure({ message: res.message, reference: res.reference });
      return;
    }
    props.onConfirmed(res.data.import, res.data.consent);
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-fg-2">
        <span className="text-fg-1">{props.view.import.fileName}</span> ({props.view.import.sheetName}): {props.view.import.rowCount.toLocaleString('en-IN')}{' '}
        {props.view.import.rowCount === 1 ? 'row' : 'rows'} below the header. The first {preview.rows.length} are shown below.
      </p>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium text-fg-1">Which column holds what</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {IMPORT_LEAD_FIELDS.map((field) => (
            <FieldSelect key={field} field={field} header={preview.header} mapping={mapping} onChange={setField} required={field === 'name'} />
          ))}
        </div>
        <p className="text-xs text-fg-2">Suggested from the column names; check each one. A row needs a business name and a valid phone number or email to become a lead.</p>
      </fieldset>

      <PreviewTable view={props.view} mapping={mapping} />

      <div className="flex max-w-md flex-col gap-1.5">
        <Label htmlFor={sourceId} className="text-fg-2">
          Where this list came from
        </Label>
        <NativeSelect id={sourceId} value={dataSource} onChange={(e) => setDataSource(e.target.value)}>
          <option value="">Choose one</option>
          {ImportDataSource.map((s) => (
            <option key={s} value={s}>
              {IMPORT_DATA_SOURCE_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
      </div>

      {props.consent.allowed ? (
        <ConsentSection
          consent={props.consent}
          header={preview.header}
          mapping={mapping}
          onField={setField}
          dataSource={dataSource}
          notice={notice}
          onNotice={setNotice}
          attested={attested}
          onAttested={setAttested}
        />
      ) : null}

      {failure ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-danger">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {failure.message}
            {failure.reference ? <span className="text-fg-2"> Reference: {failure.reference}</span> : null}
          </span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-start gap-3">
        <GatedAction
          label={`Import ${props.view.import.rowCount.toLocaleString('en-IN')} ${props.view.import.rowCount === 1 ? 'row' : 'rows'}`}
          pendingLabel="Starting..."
          icon={<Upload aria-hidden="true" />}
          gate={null}
          onAction={confirm}
        />
        <Button variant="outline" onClick={props.onStartOver}>
          Choose another file
        </Button>
      </div>
    </div>
  );
}
