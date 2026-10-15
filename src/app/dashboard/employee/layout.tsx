/**
 * Employee panel layout (T08). No session: /login. A session of another role: 404 (A6, the same
 * answer as any route the actor may not see). The chrome (workspace chip, banners, account) is
 * read through the server context; the browser supplies nothing but the session cookie.
 */
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { PanelShell } from '@/components/patterns/PanelShell';
import { getPageContext } from '@/server/auth/page-context';
import { getRuntime } from '@/server/boot';
import { loadPanelChrome } from '@/server/services/shell/panel-chrome';

export const dynamic = 'force-dynamic';

export default async function EmployeePanelLayout({ children }: { children: ReactNode }) {
  const page = await getPageContext();
  if (!page) redirect('/login');
  if (page.session.user.globalRole !== 'EMPLOYEE') notFound();
  const chrome = await loadPanelChrome(page.ctx, page.session, { envOutboundPaused: getRuntime().config.outboundPaused });
  return (
    <PanelShell panel="employee" chrome={chrome} csrfToken={page.csrfToken}>
      {children}
    </PanelShell>
  );
}
