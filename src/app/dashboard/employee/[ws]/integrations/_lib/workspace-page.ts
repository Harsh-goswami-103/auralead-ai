/**
 * The shared start of the T28 workspace pages (integrations, pipeline, sheets, meta, extension):
 * resolve the `[ws]` slug against the employee's active assignments exactly like the other `[ws]`
 * pages (no session: /login; another role or a workspace outside the assignments: 404, A6), and
 * read the page's model, turning a missing capability inside the workspace into `null` so the page
 * can say so instead of failing (403 inside one's own workspace is a visible restriction, plan §12).
 */
import { notFound, redirect } from 'next/navigation';
import { NotFoundError, PermissionDeniedError } from '@/lib/errors';
import { getPageContext, type PageContext } from '@/server/auth/page-context';

export async function workspacePage(ws: string): Promise<PageContext> {
  let page: PageContext | null;
  try {
    page = await getPageContext({ workspaceSlug: ws });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  if (!page) redirect('/login');
  if (page.session.user.globalRole !== 'EMPLOYEE') notFound();
  return page;
}

/** The read model, or null when the assignment lacks the capability it needs. */
export async function readOrNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof PermissionDeniedError) return null;
    throw error;
  }
}
