'use client';

/**
 * The lead import page's working area (ADR-120): upload (drag and drop or file input) -> mapping
 * and preview -> confirm -> progress (the page polls the import while the worker runs it) -> the
 * result with counts and row-level reasons. The import's id goes into the URL (`?import=`), so a
 * reload or a return later shows the same step. Data comes from the import routes only; the
 * browser never holds more than the 20 preview rows.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, RotateCcw } from 'lucide-react';
import { useCsrfToken } from '@/components/patterns/csrf';
import type { Gate } from '@/components/patterns/GatedAction';
import { Button, buttonVariants } from '@/components/ui/button';
import { leadImportHref, type ConsentDecision, type LeadImportDto, type LeadImportView } from '@/lib/schemas/lead-import';
import { usePolling } from '../use-polling';
import { FileDropZone } from './FileDropZone';
import { ImportProgress, ImportResult } from './ImportStatus';
import { MappingStep, type ConsentProps } from './MappingStep';

export type ImportWorkspaceProps = {
  workspaceSlug: string;
  /** The import page's path, for `?import=<id>`. */
  basePath: string;
  leadsHref: string;
  gate: Gate | null;
  consent: ConsentProps;
  initial: LeadImportView | null;
};

export function ImportWorkspace(props: ImportWorkspaceProps) {
  const router = useRouter();
  const csrfToken = useCsrfToken();
  const [view, setView] = useState<LeadImportView | null>(props.initial);
  const [consentDecision, setConsentDecision] = useState<ConsentDecision | null>(null);
  const [mappedConsent, setMappedConsent] = useState(false);
  const status = view?.import.effectiveStatus ?? null;
  const tracking = status === 'QUEUED' || status === 'RUNNING';

  async function refresh() {
    if (!view) return;
    try {
      const res = await fetch(leadImportHref(view.import.id, props.workspaceSlug), { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (!res.ok) return;
      const next = (await res.json()) as LeadImportView;
      setView(next);
      if (next.import.effectiveStatus !== 'QUEUED' && next.import.effectiveStatus !== 'RUNNING') router.refresh();
    } catch {
      // The next poll tries again.
    }
  }
  const { exhausted } = usePolling(tracking, () => void refresh());

  function show(next: LeadImportView) {
    setView(next);
    router.replace(`${props.basePath}?${new URLSearchParams({ import: next.import.id }).toString()}`, { scroll: false });
  }

  function startOver() {
    setView(null);
    setConsentDecision(null);
    setMappedConsent(false);
    router.replace(props.basePath, { scroll: false });
  }

  function confirmed(dto: LeadImportDto, decision: ConsentDecision, optInMapped: boolean) {
    setConsentDecision(decision);
    setMappedConsent(decision.requested || optInMapped);
    setView({ import: dto, preview: null });
  }

  if (view === null) return <FileDropZone workspaceSlug={props.workspaceSlug} csrfToken={csrfToken} gate={props.gate} onUploaded={show} />;

  if (status === 'PREVIEW' && view.preview) {
    return <MappingStep view={view} workspaceSlug={props.workspaceSlug} csrfToken={csrfToken} consent={props.consent} onConfirmed={confirmed} onStartOver={startOver} />;
  }

  if (tracking) return <ImportProgress dto={view.import} exhausted={exhausted} />;

  if (status === 'SUCCEEDED' || status === 'FAILED') {
    return (
      <div className="flex flex-col gap-4">
        <ImportResult dto={view.import} consent={consentDecision} mappedConsent={mappedConsent} />
        <div className="flex flex-wrap gap-3">
          <Link href={props.leadsHref} className={buttonVariants({ variant: 'secondary' })}>
            View leads
            <ArrowRight aria-hidden="true" />
          </Link>
          <Button variant="outline" onClick={startOver}>
            <RotateCcw aria-hidden="true" />
            Import another file
          </Button>
        </div>
      </div>
    );
  }

  // An expired preview, or a preview whose rows are gone.
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="text-sm text-fg-2">
        This upload expired and its rows were deleted (uploads are kept for 24 hours until they are confirmed). Upload the file again.
      </p>
      <div>
        <Button variant="outline" onClick={startOver}>
          <RotateCcw aria-hidden="true" />
          Upload a file
        </Button>
      </div>
    </div>
  );
}
