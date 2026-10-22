import type { Metadata } from 'next';
import { getConfig } from '@/lib/config';
import { DocsIndexView } from './_components/views';

export const metadata: Metadata = {
  title: 'Documentation',
  description: 'Going live, roles, the lead-to-quote workflow, messaging rules, security, data and privacy, troubleshooting and limitations.',
};

/* Public (no session). Dynamic: the mode picks the banner and the labels, and the CSP nonce needs a per-request render (ADR-69). */
export const dynamic = 'force-dynamic';

/** In-app documentation index (plan T37). */
export default function DocsIndexPage() {
  return <DocsIndexView mode={getConfig().mode} />;
}
