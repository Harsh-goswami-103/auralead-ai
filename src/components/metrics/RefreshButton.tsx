'use client';

/**
 * Re-reads the dashboard from the database (router.refresh re-runs the server page; plan §10
 * "metrics show As of time and a refresh action"). Nothing ticks or polls: numbers change only when
 * someone asks for a fresh read, and the "As of" time moves with them.
 */
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';

export function RefreshButton(props: { label?: string; size?: 'sm' | 'default'; className?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const label = props.label ?? 'Refresh';
  return (
    <Button
      type="button"
      variant="outline"
      size={props.size ?? 'default'}
      aria-busy={pending || undefined}
      disabled={pending}
      className={props.className}
      onClick={() => startTransition(() => router.refresh())}
    >
      <RefreshCw aria-hidden="true" className={cn(pending && 'motion-safe:animate-spin')} />
      {pending ? 'Refreshing' : label}
    </Button>
  );
}
