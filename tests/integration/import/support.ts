/**
 * Shared harness for the lead import tests (ADR-120, slice F2): the seeded DEMO DB (workspace A is
 * the dental clinic whose OWNER is the `owner` persona: every capability, consent.import included;
 * `pooja` is a MEMBER of kesari-crafts with leads.import only; the `employee` operator of workspace
 * A has no leads.import), a temp STORAGE_DIR, the withRoute runtime on it, an in-process worker
 * with the two import jobs, and file builders for CSV and XLSX uploads.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '@/lib/config';
import { writeXlsx } from '@/lib/spreadsheet';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import type { AppCtx } from '@/server/auth/context';
import { createLeadImportJob, createLeadImportPurgeJob } from '@/server/jobs/handlers/lead-import';
import { uploadLeadImport } from '@/server/services/leads/import';
import type { Worker } from '../../../worker/worker';
import { seedId } from '../../../prisma/seed/ids';
import { testConfig, uninstallRuntime, useRuntime as installTestRuntime } from '../auth/support';
import { createQuoteHarness, drain, userCtx, workerWith, type QuoteHarness } from '../leads/support';

export { userCtx, WS_A, WS_A_SLUG, WS_KESARI_SLUG, DAY, NOW } from '../leads/support';

export type ImportHarness = QuoteHarness & { storageDir: string; config: AppConfig; pepper: string; worker: Worker; drain: () => Promise<void>; cleanup: () => Promise<void> };

export async function createImportHarness(label: string): Promise<ImportHarness> {
  const h = await createQuoteHarness(label);
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), `auralead-import-${label}-`));
  const config = testConfig('demo', { STORAGE_DIR: storageDir });
  installTestRuntime(h.db, config, h.clock);
  const pepper = config.secrets.suppressionPepper!;
  const worker = workerWith(h, [
    createLeadImportJob({ deps: () => ({ storageDir, contactKeyPepper: pepper, mode: 'demo' }) }),
    createLeadImportPurgeJob({ deps: () => ({ storageDir, mode: 'demo' }) }),
  ]);
  return {
    ...h,
    storageDir,
    config,
    pepper,
    worker,
    drain: () => drain(worker),
    cleanup: async () => {
      uninstallRuntime();
      await h.testDb.destroy();
      fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/** RFC 4180 CSV text of a header and rows (fields with commas or quotes are quoted). */
export function csvText(rows: readonly (readonly string[])[]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export const b64 = (bytes: Uint8Array | string) => Buffer.from(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes).toString('base64');

export function csvUpload(rows: readonly (readonly string[])[], requestKey: string, fileName = 'leads.csv') {
  return { requestKey, fileName, contentType: 'text/csv', dataBase64: b64(csvText(rows)) };
}

export function xlsxUpload(header: readonly string[], rows: readonly (readonly string[])[], requestKey: string, fileName = 'leads.xlsx') {
  return { requestKey, fileName, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', dataBase64: b64(writeXlsx({ sheetName: 'Leads', header, rows })) };
}

/** `count` valid rows: name, a distinct valid Indian mobile, a city. */
export function businessRows(count: number, prefix: string, firstNumber = 0): string[][] {
  return Array.from({ length: count }, (_, i) => [`${prefix} ${i + 1}`, `+91 98${String(10_000_000 + firstNumber + i).padStart(8, '0')}`, 'Indore']);
}

export async function upload(h: ImportHarness, ctx: AppCtx, body: ReturnType<typeof csvUpload>) {
  return uploadLeadImport(ctx, body, { storageDir: h.storageDir });
}

/** A signed-in cookie and CSRF token for route calls. */
export async function authAs(h: Pick<ImportHarness, 'db' | 'clock' | 'config'>, key: string) {
  const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', key) } });
  const { token, session } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'i', userAgent: 'vitest', now: h.clock.now() });
  return { cookie: `${sessionCookieName(h.config)}=${token}`, csrf: csrfTokenForSession(h.config, session.id) };
}

export const ownerOf = (h: ImportHarness) => userCtx(h.db, h.clock, 'owner');
