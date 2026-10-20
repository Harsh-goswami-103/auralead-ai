'use client';

/**
 * Error boundary for the user panel's pages (design spec §6 "System pages"). It sits inside the
 * panel layout, so PanelShell stays and only the page area is replaced. It never wraps the
 * layout's own notFound() or redirect(), and it starts no streaming boundary, so every status
 * code is unchanged. Retry re-fetches and re-renders the segment.
 */
import { PanelRouteError } from '@/components/patterns/PanelRouteError';

export default function PanelError(props: { error: Error & { digest?: string }; retry: () => void }) {
  return <PanelRouteError panel="user" error={props.error} retry={props.retry} />;
}
