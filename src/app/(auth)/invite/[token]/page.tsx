import type { Metadata } from 'next';
import { AuthFrame } from '../../_components/auth-frame';
import { CredentialForm } from '../../_components/credential-form';

export const metadata: Metadata = { title: { absolute: 'Accept invitation | AuraLead AI' }, robots: { index: false, follow: false }, referrer: 'no-referrer' };
export const dynamic = 'force-dynamic';

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <AuthFrame
      title="Accept your invitation"
      description="Set your name and a password. If you already have an account, enter your current password instead."
    >
      <CredentialForm
        action="/api/app/auth/invite/accept"
        extra={{ token }}
        submitLabel="Join"
        pendingLabel="Joining..."
        fields={[
          { name: 'name', label: 'Your name', type: 'text', autoComplete: 'name' },
          { name: 'password', label: 'Password', type: 'password', autoComplete: 'new-password', minLength: 12, hint: 'At least 12 characters.' },
        ]}
      />
    </AuthFrame>
  );
}
