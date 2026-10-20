/**
 * The landing's call to action (plan T30): one route, two honest labels. DEMO opens the seeded
 * demo at /login (persona sign-in); LIVE has invitation-only accounts, so the same link says
 * "Sign in". Server-safe.
 */
import { ArrowRight, LogIn } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';

export type LandingMode = 'demo' | 'live';

export const ctaLabel = (mode: LandingMode) => (mode === 'demo' ? 'Open live demo' : 'Sign in');

export function PrimaryCta(props: { mode: LandingMode; size?: 'default' | 'sm' | 'lg'; className?: string }) {
  const Icon = props.mode === 'demo' ? ArrowRight : LogIn;
  return (
    <Button asChild size={props.size ?? 'lg'} className={cn('font-semibold', props.className)}>
      <Link href="/login" data-landing-cta="primary">
        {ctaLabel(props.mode)}
        <Icon aria-hidden="true" />
      </Link>
    </Button>
  );
}
