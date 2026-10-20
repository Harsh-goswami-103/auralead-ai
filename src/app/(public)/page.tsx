import type { Metadata } from 'next';
import { LandingPage } from '@/components/landing/LandingPage';
import { getConfig } from '@/lib/config';

export const metadata: Metadata = {
  title: { absolute: 'AuraLead AI: leads in, quotes out' },
  description: 'Lead capture, scoring, versioned quotes and consent-aware WhatsApp and email for Indian service businesses.',
};

/* The mode decides the CTA label (DEMO: open the demo; LIVE: sign in), so it is read per request. */
export const dynamic = 'force-dynamic';

/** Public landing page (plan T30). */
export default function HomePage() {
  return <LandingPage mode={getConfig().mode} />;
}
