'use client';

/**
 * CopyButton: copies one value (an id, a key, a JSON payload) to the clipboard and says so with a
 * toast and a check mark for a moment. The accessible name names what is copied ("Copy job id").
 * Without the async clipboard API (old browsers, insecure origins) it reports that instead of
 * pretending. A small client island inside server-rendered admin pages.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';

export function CopyButton(props: { value: string; label: string; className?: string; showText?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      toast.error('Copy is not available in this browser. Select the text and copy it instead.');
      return;
    }
    try {
      await navigator.clipboard.writeText(props.value);
    } catch {
      toast.error('The clipboard refused the copy. Select the text and copy it instead.');
      return;
    }
    setCopied(true);
    toast.success(`Copied ${props.label}.`);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }

  const Icon = copied ? Check : Copy;
  return (
    <Button
      type="button"
      variant="ghost"
      size={props.showText ? 'xs' : 'icon-xs'}
      aria-label={`Copy ${props.label}`}
      onClick={() => void copy()}
      className={cn('text-fg-2 hover:text-fg-1', copied && 'text-success hover:text-success', props.className)}
    >
      <Icon aria-hidden="true" />
      {props.showText ? (copied ? 'Copied' : 'Copy') : null}
    </Button>
  );
}
