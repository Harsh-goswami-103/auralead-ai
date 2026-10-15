/**
 * PartialNotice (06-design §11.3 PARTIAL column): what is shown is real, and the parts that
 * failed or are pending are named, so a partial result never passes for a complete one.
 */
import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { cn } from '@/components/ui/cn';

export function PartialNotice(props: { title: string; items?: string[]; action?: ReactNode; className?: string }) {
  return (
    <div role="status" className={cn('flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2', props.className)}>
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="flex flex-col gap-1">
        <p className="font-medium text-fg-1">{props.title}</p>
        {props.items && props.items.length > 0 ? (
          <ul className="list-disc pl-4 text-fg-2">
            {props.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}
        {props.action}
      </div>
    </div>
  );
}
