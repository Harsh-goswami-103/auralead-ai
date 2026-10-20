import type { Metadata } from 'next';
import { AuthFrame } from '../../_components/auth-frame';
import { CredentialForm } from '../../_components/credential-form';

export const metadata: Metadata = { title: { absolute: 'Reset password | AuraLead AI' }, robots: { index: false, follow: false }, referrer: 'no-referrer' };
export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <AuthFrame
      title="Choose a new password"
      description="This link works once and expires one hour after your administrator created it. You will sign in again afterwards."
    >
      <CredentialForm
        action="/api/app/auth/reset"
        extra={{ token }}
        submitLabel="Set password"
        pendingLabel="Saving..."
        fields={[{ name: 'password', label: 'New password', type: 'password', autoComplete: 'new-password', minLength: 12, hint: 'At least 12 characters.' }]}
      />
    </AuthFrame>
  );
}
