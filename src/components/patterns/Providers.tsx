'use client';

/**
 * App-wide client providers: Motion honours the OS reduced-motion setting everywhere
 * (06-design §11.10 item 6), Radix tooltips share one provider, and Sonner toasts are mounted once
 * (polite live region, 06-design §11.11).
 */
import { MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}>
      <TooltipProvider delayDuration={300}>
        {children}
        <Toaster position="bottom-center" closeButton />
      </TooltipProvider>
    </MotionConfig>
  );
}
