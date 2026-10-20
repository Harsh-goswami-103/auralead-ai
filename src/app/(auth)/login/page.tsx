import type { Metadata } from 'next';
import { DemoPersonaSignIn } from '@/components/patterns/DemoChrome';
import { ModeBanner } from '@/components/patterns/ModeBanner';
import { getConfig } from '@/lib/config';
import { AuthFrame } from '../_components/auth-frame';
import { CredentialForm } from '../_components/credential-form';

export const metadata: Metadata = { title: { absolute: 'Sign in | AuraLead AI' } };
export const dynamic = 'force-dynamic';

/**
 * LIVE: email and password (accounts exist only by invitation). DEMO: the seeded identities only
 * (06-design §11.2.1), through the same server-mapped persona route as the role switcher.
 */
export default function LoginPage() {
  const { mode } = getConfig();
  if (mode === 'demo') {
    return (
      <AuthFrame
        banner={<ModeBanner mode="demo" />}
        title="Open the demo"
        description="Choose a seeded identity. Each opens its own panel with simulated providers; nothing leaves this app."
        footnote="Demo identities exist only in DEMO mode and never carry production privileges."
      >
        <DemoPersonaSignIn />
      </AuthFrame>
    );
  }
  return (
    <AuthFrame
      title="Sign in"
      description="Accounts are created by invitation from your administrator."
      footnote="Five failed attempts lock the account for 15 minutes. Lost your password? Ask your administrator for a reset link."
    >
      <CredentialForm
        action="/api/app/auth/login"
        submitLabel="Sign in"
        pendingLabel="Signing in..."
        fields={[
          { name: 'email', label: 'Email', type: 'email', autoComplete: 'username' },
          { name: 'password', label: 'Password', type: 'password', autoComplete: 'current-password' },
        ]}
      />
    </AuthFrame>
  );
}
