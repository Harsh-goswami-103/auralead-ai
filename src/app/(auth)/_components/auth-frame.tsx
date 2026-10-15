/**
 * The calm frame shared by /login and /invite: product mark, one card, a short footnote. No glow
 * and no glass (06-design §11.8); the only color accent is the cyan focus and primary action.
 */
import type { ReactNode } from 'react';
import { ProductMark } from '@/components/patterns/ProductMark';

export function AuthFrame(props: { title: string; description: ReactNode; children: ReactNode; footnote?: ReactNode; banner?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      {props.banner}
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="flex w-full max-w-sm flex-col gap-8">
          <div className="flex items-center gap-2.5">
            <ProductMark className="size-8" />
            <span className="font-display text-lg font-semibold tracking-tight text-fg-1">AuraLead AI</span>
          </div>
          <section className="flex flex-col gap-6 rounded-xl border border-border-subtle bg-bg-1 p-6">
            <div className="flex flex-col gap-1.5">
              <h1 className="font-display text-2xl font-semibold text-fg-1">{props.title}</h1>
              <div className="text-fg-2">{props.description}</div>
            </div>
            {props.children}
          </section>
          {props.footnote ? <div className="text-xs text-fg-3">{props.footnote}</div> : null}
        </div>
      </main>
    </div>
  );
}
