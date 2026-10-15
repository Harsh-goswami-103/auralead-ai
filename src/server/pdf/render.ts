/**
 * Renders a quote render model to PDF bytes with @react-pdf/renderer (T16, C1). Runs in the worker
 * (`quote.renderPdf`), never per request.
 *
 * Fonts: Inter 4.1 Regular and SemiBold TTF, bundled under ./fonts with their SIL Open Font
 * License (fonts/OFL.txt). Inter covers U+20B9 (₹), so amounts print as text and pdfjs extracts
 * them. The files are found next to this module (tsx, vitest) or, for the bundled worker
 * (dist/worker.js), under `<cwd>/src/server/pdf/fonts`; the worker always runs with the repo root
 * as its working directory (it checks migrations from there).
 *
 * Output is deterministic for a given model: the PDF creation date is the version's issue time,
 * and pdfkit derives the file id and font subset tags from the content, so a re-render after a
 * crash writes byte-identical bytes (AT12 restart consistency).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { Font, renderToBuffer } from '@react-pdf/renderer';
import type { QuoteRenderModel } from '@/server/services/quotes/render-model';
import { PDF_FONT_FAMILY, QuotePdf } from './QuotePdf';

export const PDF_FONT_FILES = { regular: 'Inter-Regular.ttf', semibold: 'Inter-SemiBold.ttf' } as const;

function moduleDir(): string | null {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

export function resolveFontDir(): string {
  const here = moduleDir();
  const candidates = [here ? path.join(here, 'fonts') : null, path.join(process.cwd(), 'src', 'server', 'pdf', 'fonts')].filter((c): c is string => c !== null);
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, PDF_FONT_FILES.regular)) && fs.existsSync(path.join(dir, PDF_FONT_FILES.semibold)));
  if (!found) throw new Error(`Inter font files not found (looked in ${candidates.join(', ')})`);
  return found;
}

let registered = false;

function registerFonts(): void {
  if (registered) return;
  const dir = resolveFontDir();
  Font.register({
    family: PDF_FONT_FAMILY,
    fonts: [
      { src: path.join(dir, PDF_FONT_FILES.regular), fontWeight: 400 },
      { src: path.join(dir, PDF_FONT_FILES.semibold), fontWeight: 600 },
    ],
  });
  // Words are never hyphenated (service names and amounts must stay whole).
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}

export async function renderQuotePdf(model: QuoteRenderModel): Promise<Buffer> {
  registerFonts();
  const element = createElement(QuotePdf, { model }) as unknown as Parameters<typeof renderToBuffer>[0];
  return renderToBuffer(element);
}
