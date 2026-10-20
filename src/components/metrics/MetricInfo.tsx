'use client';

/**
 * "How is this counted?" (06-design §11.1: KPI definitions in an info popover). A button opens a
 * popover with the metric's label and its definition string, exactly as the metrics service
 * exports it. `text` shows the words "How it's counted" beside the icon (the accessible name starts
 * with them, then names the metric); `icon` is the compact form for table headers. Keyboard: Tab to
 * the button, Enter or Space opens, Escape closes and returns focus (Radix Popover).
 */
import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';

export function MetricInfo(props: { label: string; definition: string; variant?: 'text' | 'icon'; className?: string }) {
  const text = (props.variant ?? 'text') === 'text';
  return (
    <Popover>
      <PopoverTrigger asChild>
        {text ? (
          <Button variant="ghost" size="xs" className={cn('-ml-1.5 w-fit text-fg-2 hover:text-fg-1', props.className)}>
            <Info aria-hidden="true" />
            How it&apos;s counted<span className="sr-only">: {props.label}</span>
          </Button>
        ) : (
          <Button variant="ghost" size="icon-xs" aria-label={`How "${props.label}" is counted`} className={cn('text-fg-2 hover:text-fg-1', props.className)}>
            <Info aria-hidden="true" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <PopoverHeader>
          <PopoverTitle>{props.label}</PopoverTitle>
          <PopoverDescription>{props.definition}</PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  );
}
