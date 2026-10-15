/**
 * `quote.renderPdf` (T16, C1, ADR-08): renders a quote version's PDF and records its QuoteArtifact.
 * Enqueued in the version-creating transaction and by a PDF route that finds no artifact.
 * Payload v1 `{ quoteVersionId }`, workspace job, kind pdf (3 attempts).
 *
 * Steps: an existing artifact ends the job (idempotent). Otherwise the render model is read, the
 * PDF rendered and written to STORAGE_DIR outside any transaction (CPU and file I/O, no DB lock
 * held), then the artifact row and the `quote.pdf.render` audit commit in the fenced settle. A
 * crash between the file write and the settle leaves a file the next attempt overwrites with
 * identical bytes (rendering is deterministic).
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config';
import { NotFoundError } from '@/lib/errors';
import { quoteArtifactRelPath, QUOTE_RENDER_PDF_JOB, writeArtifactFile } from '@/server/pdf/artifacts';
import { renderQuotePdf } from '@/server/pdf/render';
import { recordAudit } from '@/server/services/audit/record';
import { loadRenderSource, buildQuoteRenderModel } from '@/server/services/quotes/render-model';
import type { JobDefinition } from '../types';
import { deadResult, jobCtx, parseWorkspacePayload } from './lead-job-support';

export { QUOTE_RENDER_PDF_JOB };

const payloadSchema = z.object({ quoteVersionId: z.string().min(1).max(64) });

export type QuoteRenderPdfJobOptions = {
  mode?: () => 'demo' | 'live';
  storageDir?: () => string;
};

export function createQuoteRenderPdfJob(options: QuoteRenderPdfJobOptions = {}): JobDefinition {
  const mode = options.mode ?? (() => getConfig().mode);
  const storageDir = options.storageDir ?? (() => getConfig().paths.storageDir);
  return {
    type: QUOTE_RENDER_PDF_JOB,
    kind: 'pdf',
    payloadVersions: [1],
    async handler(job) {
      const parsed = parseWorkspacePayload(job, payloadSchema);
      if (!parsed.ok) return parsed.result;
      const { workspaceId, payload } = parsed;
      const existing = await job.db.quoteArtifact.findFirst({ where: { workspaceId, quoteVersionId: payload.quoteVersionId }, select: { id: true } });
      if (existing) return { outcome: 'succeeded' };

      let source;
      try {
        source = await loadRenderSource(job.db, { workspaceId, quoteVersionId: payload.quoteVersionId });
      } catch (error) {
        if (error instanceof NotFoundError) return deadResult('VERSION_NOT_FOUND', 'quote version not found in the job workspace');
        throw error;
      }
      const model = buildQuoteRenderModel(source, { mode: mode() });
      const bytes = await renderQuotePdf(model);
      const file = writeArtifactFile(storageDir(), quoteArtifactRelPath(workspaceId, payload.quoteVersionId), bytes);
      const ctx = jobCtx(job, workspaceId, mode());

      return {
        outcome: 'succeeded',
        finalTx: async (tx) => {
          const again = await tx.quoteArtifact.findFirst({ where: { workspaceId, quoteVersionId: payload.quoteVersionId }, select: { id: true } });
          if (again) return;
          await tx.quoteArtifact.create({
            data: { workspaceId, quoteVersionId: payload.quoteVersionId, path: file.path, sha256: file.sha256, bytes: file.bytes, renderedAt: job.clock.now() },
          });
          await recordAudit(tx, ctx, {
            action: 'quote.pdf.render',
            targetType: 'Quote',
            targetId: source.quoteId,
            workspaceId,
            summary: { versionNo: source.version.versionNo, bytes: file.bytes },
          });
        },
      };
    },
  };
}

export const quoteRenderPdfJob = createQuoteRenderPdfJob();
