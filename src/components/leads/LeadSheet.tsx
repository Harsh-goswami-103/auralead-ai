'use client';

/**
 * The lead detail sheet of the client panel's Leads page (T26, R31). The page renders it when the
 * URL names a lead (`?lead=<id>`), so a reload or a shared link reopens it; closing it (Escape, the
 * close button, the overlay) returns to the same list or board without the `lead` parameter. The
 * body is rendered on the server and passed in. Focus is trapped and restored by Radix.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Maximize2 } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';

export function LeadSheet(props: { title: string; description: string; closeHref: string; fullPageHref: string; children: ReactNode }) {
  const router = useRouter();
  // Closes at once; the page then re-renders without the `lead` parameter (and without this sheet).
  const [open, setOpen] = useState(true);
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        setOpen(false);
        router.push(props.closeHref, { scroll: false });
      }}
    >
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{props.title}</SheetTitle>
          <SheetDescription>{props.description}</SheetDescription>
          <Link href={props.fullPageHref} className={buttonVariants({ variant: 'outline', size: 'sm', className: 'w-fit' })}>
            <Maximize2 aria-hidden="true" />
            Open full page
          </Link>
        </SheetHeader>
        <div className="px-4 pb-6">{props.children}</div>
      </SheetContent>
    </Sheet>
  );
}
