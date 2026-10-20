'use client';

/**
 * The body of a panel segment's error.tsx (src/app/dashboard/{user,employee,admin}/error.tsx). An
 * error.tsx never wraps its own segment's layout, so PanelShell (top bar, nav, banners) stays and
 * only the page area shows this. It renders a PageHeader in the panel hue (the page's h1, since
 * the failed page rendered none) and ErrorState with the digest as the Reference and a retry. It
 * never shows error.message. Shared so the three panels fail alike.
 */
import { ErrorState } from './ErrorState';
import { PageHeader } from './PageHeader';
import { PANELS, type PanelKey } from './panel-nav';

export function PanelRouteError(props: { panel: PanelKey; error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={PANELS[props.panel].title}
        title="This page could not be loaded"
        description="The rest of the panel still works. Try again, or open another section."
      />
      <ErrorState
        correlationId={props.error.digest ?? 'not available'}
        title="Loading this page failed"
        onRetry={() => props.retry()}
        className="max-w-2xl"
      />
    </div>
  );
}
