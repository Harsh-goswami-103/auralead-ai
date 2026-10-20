/**
 * The workspace pages' answer when the assignment lacks `leads.read` (the capability every
 * workspace page reads with): a visible restriction with who can lift it, never an empty page.
 * Server-safe.
 */
import { Lock } from 'lucide-react';
import { EmptyState } from '@/components/patterns/EmptyState';

export function NotInAssignment({ what }: { what: string }) {
  return (
    <EmptyState
      icon={<Lock aria-hidden="true" className="size-5" />}
      title={`${what} is not part of your assignment`}
      description="Your assignment in this workspace does not include reading leads, which this page needs. A super admin can change it on the people page."
    />
  );
}
