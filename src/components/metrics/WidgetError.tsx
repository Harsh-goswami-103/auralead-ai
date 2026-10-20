/**
 * A dashboard section whose numbers could not be read (06-design §11.3 PARTIAL): says so, gives the
 * request reference (never a stack or code) and offers Retry, which re-reads the page. The other
 * sections keep their numbers. Server-safe.
 */
import { TriangleAlert } from 'lucide-react';
import { RefreshButton } from './RefreshButton';

export function WidgetError(props: { what: string; reference: string }) {
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/35 bg-danger/8 px-3 py-2.5 text-sm text-fg-1">
      <span className="flex items-start gap-2">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
        <span>
          {props.what} could not be loaded.
          <span className="block text-xs text-fg-2">Reference: {props.reference}</span>
        </span>
      </span>
      <RefreshButton size="sm" label="Retry" />
    </div>
  );
}
