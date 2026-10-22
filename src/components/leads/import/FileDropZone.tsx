'use client';

/**
 * Step 1 of the lead import (ADR-120): drop an .xlsx or .csv file on the zone or choose it with
 * the button. The browser checks the type and the 5 MB limit first for a quick answer, then sends
 * the file as base64 in JSON; the server parses it and answers with the preview. Without
 * leads.import the button stays focusable and says why (plan §12), and the zone takes no files.
 */
import { useId, useRef, useState, type DragEvent } from 'react';
import { FileSpreadsheet, TriangleAlert, Upload } from 'lucide-react';
import { newRequestKey } from '@/components/inbox/api';
import { postJson } from '@/components/patterns/api-client';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { cn } from '@/components/ui/cn';
import { LEAD_IMPORT_ACCEPT, LEAD_IMPORT_EXTENSIONS, LEAD_IMPORT_MAX_FILE_BYTES, LEAD_IMPORT_MAX_ROWS, type LeadImportView } from '@/lib/schemas/lead-import';

type Failure = { message: string; reference: string | null } | null;

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** A quick answer before the upload; the server checks everything again. */
export function precheckImportFile(file: { name: string; size: number }): string | null {
  const name = file.name.toLowerCase();
  if (!LEAD_IMPORT_EXTENSIONS.some((ext) => name.endsWith(ext))) return 'Choose an .xlsx or .csv file. Save older .xls workbooks as .xlsx first.';
  if (file.size === 0) return 'The file is empty.';
  if (file.size > LEAD_IMPORT_MAX_FILE_BYTES) return 'The file is larger than 5 MB. Split it into smaller files.';
  return null;
}

export function FileDropZone(props: { workspaceSlug: string; csrfToken: string | null; gate: Gate | null; onUploaded: (view: LeadImportView) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure>(null);

  async function upload(file: File) {
    const problem = precheckImportFile(file);
    if (problem) {
      setFailure({ message: problem, reference: null });
      return;
    }
    setFailure(null);
    setPending(true);
    try {
      const dataBase64 = await readAsBase64(file);
      const res = await postJson<LeadImportView & { created: boolean }>(
        '/api/app/leads/imports',
        { workspaceSlug: props.workspaceSlug, requestKey: newRequestKey(), fileName: file.name, contentType: file.type, dataBase64 },
        props.csrfToken,
      );
      if (!res.ok) setFailure({ message: res.message, reference: res.reference });
      else props.onUploaded({ import: res.data.import, preview: res.data.preview });
    } catch {
      setFailure({ message: 'The file could not be read. Choose it again.', reference: null });
    } finally {
      setPending(false);
      if (input.current) input.current.value = '';
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file && !pending) void upload(file);
  }

  const gated = props.gate !== null;
  return (
    <div className="flex flex-col gap-3">
      <div
        data-dropzone=""
        data-dragging={dragging ? 'true' : 'false'}
        onDragOver={
          gated
            ? undefined
            : (event) => {
                event.preventDefault();
                setDragging(true);
              }
        }
        onDragLeave={gated ? undefined : () => setDragging(false)}
        onDrop={gated ? undefined : onDrop}
        className={cn(
          'flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-[border-color,background-color] duration-fast',
          dragging ? 'border-aura bg-aura/10' : 'border-border-strong bg-bg-2/60',
        )}
      >
        <span aria-hidden="true" className="flex size-11 items-center justify-center rounded-xl bg-bg-3 text-fg-2">
          <FileSpreadsheet className="size-5" />
        </span>
        <p id={hintId} className="max-w-prose text-sm text-fg-2">
          Drag an Excel (.xlsx) or CSV file here, or choose it. Up to 5 MB and {LEAD_IMPORT_MAX_ROWS.toLocaleString('en-IN')} rows below the header row.
        </p>
        <GatedAction label="Choose a file" pendingLabel="Uploading..." icon={<Upload aria-hidden="true" />} gate={props.gate} onAction={() => input.current?.click()} />
        <input
          ref={input}
          type="file"
          accept={LEAD_IMPORT_ACCEPT}
          aria-label="Spreadsheet file to import"
          aria-describedby={hintId}
          tabIndex={-1}
          className="sr-only"
          disabled={gated || pending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        {pending ? (
          <p role="status" className="text-sm text-fg-2">
            Uploading and reading the file...
          </p>
        ) : null}
      </div>
      {failure ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-danger">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {failure.message}
            {failure.reference ? <span className="text-fg-2"> Reference: {failure.reference}</span> : null}
          </span>
        </p>
      ) : null}
    </div>
  );
}
