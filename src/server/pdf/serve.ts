/**
 * Serving quote PDFs (T16, C1): the share route and the authenticated route both hand out the
 * stored artifact, never a render made at request time. When the artifact does not exist yet the
 * caller gets `{ ready: false }` (the route answers 503 + Retry-After) and one render job is
 * enqueued (idempotent per version).
 */
import type { PrismaClient } from '@/generated/prisma/client';
import { NotFoundError } from '@/lib/errors';
import type { AppCtx } from '@/server/auth/context';
import { requireWorkspace } from '@/server/auth/guards';
import { resolveShare, type PublicDeps } from '@/server/services/quotes/public-share';
import { enqueueQuoteRenderPdf, PDF_RETRY_AFTER_SECONDS, pdfFileName, readArtifactFile } from './artifacts';

export type PdfResult = { ready: true; bytes: Buffer; fileName: string } | { ready: false; retryAfterSeconds: number };

async function artifactOrEnqueue(
  db: PrismaClient,
  deps: { clock: PublicDeps['clock']; correlationId: string },
  input: { workspaceId: string; quoteVersionId: string; quoteNumber: string; versionNo: number; storageDir: string },
): Promise<PdfResult> {
  const artifact = await db.quoteArtifact.findFirst({ where: { workspaceId: input.workspaceId, quoteVersionId: input.quoteVersionId } });
  if (artifact) return { ready: true, bytes: readArtifactFile(input.storageDir, artifact), fileName: pdfFileName(input.quoteNumber, input.versionNo) };
  await enqueueQuoteRenderPdf(db, deps.clock, { workspaceId: input.workspaceId, quoteVersionId: input.quoteVersionId, correlationId: deps.correlationId });
  return { ready: false, retryAfterSeconds: PDF_RETRY_AFTER_SECONDS };
}

/** The PDF of the version a live share link points at (404 / 410 exactly as the page). */
export async function getSharedQuotePdf(deps: PublicDeps, token: string, storageDir: string): Promise<PdfResult> {
  const { share, quote } = await resolveShare(deps.db, token, deps.clock.now());
  const version = await deps.db.quoteVersion.findFirstOrThrow({ where: { id: share.quoteVersionId, workspaceId: share.workspaceId }, select: { versionNo: true } });
  return artifactOrEnqueue(deps.db, deps, { workspaceId: share.workspaceId, quoteVersionId: share.quoteVersionId, quoteNumber: quote.number, versionNo: version.versionNo, storageDir });
}

/** A quote PDF for a signed-in member of the quote's workspace: the current version, or `versionNo`. */
export async function getWorkspaceQuotePdf(ctx: AppCtx, db: PrismaClient, input: { quoteId: string; versionNo?: number; storageDir: string }): Promise<PdfResult> {
  const workspaceId = requireWorkspace(ctx);
  const quote = await ctx.db.quote.findFirst({ where: { id: input.quoteId } });
  if (!quote) throw new NotFoundError();
  const version = await ctx.db.quoteVersion.findFirst({
    where: input.versionNo === undefined ? { id: quote.currentVersionId ?? '' } : { quoteId: quote.id, versionNo: input.versionNo },
    select: { id: true, versionNo: true },
  });
  if (!version) throw new NotFoundError();
  return artifactOrEnqueue(db, ctx, { workspaceId, quoteVersionId: version.id, quoteNumber: quote.number, versionNo: version.versionNo, storageDir: input.storageDir });
}
