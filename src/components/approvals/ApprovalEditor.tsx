'use client';

/**
 * Edit the quotation behind an approval item (T22: "edits within pricing permissions"). Reuses the
 * T15 quote editor and saves through /api/app/approvals/[id]/revise with the item's workspace slug:
 * the server prices the new version, and a discount above the editor's own cap is refused (403,
 * shown with its reference). Without `quotes.edit` the control is gated by permission.
 *
 * Focus (WCAG 2.4.3): opening moves focus to the editor's heading, and closing or saving returns it
 * to the "Edit quotation" button, so keyboard and screen-reader users keep their place. The button
 * sizes to its label (it no longer stretches across the column). The editor opens and closes with
 * a short height + fade (motion; MotionConfig reducedMotion="user" keeps it to a fade). Its heading
 * carries the same icon chip as the page's other section titles.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, PencilLine, X } from 'lucide-react';
import { IconChip } from '@/components/client/IconChip';
import { GatedAction } from '@/components/patterns/GatedAction';
import { Button } from '@/components/ui/button';
import { duration, ease, exitTransition } from '@/components/motion/presets';
import { QuoteEditor, type EditorInitial } from '@/app/dashboard/user/quotations/quote-editor';
import type { QuoteEditorCatalogDto } from '@/server/services/quotes/versioning';

export function ApprovalEditor(props: {
  approvalId: string;
  workspaceSlug: string;
  quoteId: string;
  versionNo: number;
  pricingVersionId: string;
  pricingVersionNo: number | null;
  catalog: QuoteEditorCatalogDto;
  initial: EditorInitial;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  // Where focus goes after the next open/close: set by the user's action, consumed by the effect.
  const pendingFocus = useRef<'editor' | 'trigger' | null>(null);

  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    if (target === 'editor') headingRef.current?.focus();
    else triggerRef.current?.querySelector<HTMLElement>('button, a')?.focus();
  }, [open]);

  const openEditor = () => {
    pendingFocus.current = 'editor';
    setOpen(true);
  };
  const closeEditor = () => {
    pendingFocus.current = 'trigger';
    setOpen(false);
  };

  return (
    <div className="flex min-w-0 flex-col">
      {open ? null : (
        <div ref={triggerRef} className="self-start">
          <GatedAction
            label="Edit quotation (new version)"
            variant="outline"
            icon={<PencilLine aria-hidden="true" />}
            gate={props.canEdit ? null : { category: 'permission', reason: 'Your assignment in this workspace does not include editing quotations.' }}
            onAction={openEditor}
          />
        </div>
      )}
      <AnimatePresence initial={false}>
        {open ? (
          <motion.section
            key="editor"
            aria-labelledby="edit-heading"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto', transition: { duration: duration.base, ease: ease.enter } }}
            exit={{ opacity: 0, height: 0, transition: exitTransition }}
            className="overflow-hidden"
          >
            <div className="relative flex flex-col gap-4 rounded-xl border border-aura/35 bg-bg-1 p-4 sm:p-5">
              <span aria-hidden="true" className="pointer-events-none absolute inset-x-3 -top-px h-0.5 rounded-full [background-image:var(--grad-hairline)]" />
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex flex-col gap-1.5">
                  <h2 id="edit-heading" ref={headingRef} tabIndex={-1} className="flex w-fit items-center gap-2.5 rounded-md font-display text-lg font-semibold text-fg-1">
                    <IconChip>
                      <PencilLine />
                    </IconChip>
                    Edit v{props.versionNo}
                  </h2>
                  <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-aura/35 bg-aura/10 px-2 py-0.5 text-xs font-medium text-fg-1">
                    Editing v{props.versionNo}
                    <ArrowRight aria-hidden="true" className="size-3 text-aura" />
                    saves as v{props.versionNo + 1}
                  </span>
                </div>
                <Button type="button" variant="ghost" onClick={closeEditor}>
                  <X aria-hidden="true" />
                  Close
                </Button>
              </div>
              <p className="text-sm text-fg-2">Saving creates version {props.versionNo + 1}, priced by the server. It needs approval again; discounts above your own limit are refused.</p>
              <QuoteEditor
                catalog={props.catalog}
                mode={{
                  kind: 'revise',
                  quoteId: props.quoteId,
                  expectedVersion: props.versionNo,
                  pricingVersionId: props.pricingVersionId,
                  pricingVersionNo: props.pricingVersionNo,
                  endpoint: `/api/app/approvals/${props.approvalId}/revise`,
                  extraBody: { workspaceSlug: props.workspaceSlug },
                }}
                initial={props.initial}
                gate={null}
                submitLabel={`Save as v${props.versionNo + 1}`}
                onSaved={closeEditor}
              />
            </div>
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
