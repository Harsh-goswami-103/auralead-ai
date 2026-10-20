'use client';

/**
 * App-wide client providers: Motion honours the OS reduced-motion setting everywhere
 * (06-design §11.10 item 6), Radix tooltips share one provider, and Sonner toasts are mounted once
 * (polite live region, 06-design §11.11). The default Motion transition is the "base" duration on
 * the enter curve from the shared presets. The toast skin and its bottom offset, which clears the
 * mobile tab bar and the safe area, live in ui/sonner.
 */
import { MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { duration, ease } from '@/components/motion/presets';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

const DEFAULT_TRANSITION = { duration: duration.base, ease: ease.enter };

export function Providers({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={DEFAULT_TRANSITION}>
      <TooltipProvider delayDuration={300}>
        {children}
        <Toaster position="bottom-center" closeButton />
      </TooltipProvider>
    </MotionConfig>
  );
}
