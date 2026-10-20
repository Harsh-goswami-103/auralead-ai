/**
 * The HTML presenter of a quote version (T16, C1). It renders exactly the render model that the
 * PDF presenter (src/server/pdf/QuotePdf.tsx) renders, so the page and the PDF carry the same
 * total, number, version and content hash (AT6). Pure and presentational: no hooks, no handlers,
 * so it renders both inside Next pages and through `renderStaticMarkup` for the public page.
 * Paper theme (plan §10); styles are in `QUOTE_DOCUMENT_CSS` (quote-css.ts), print included.
 * `data-field` attributes mark the values the parity test reads.
 *
 * Layout (design spec §6 "Public quote"): a header band in the workspace brand colour (sender
 * monogram, name and GSTIN; the "Quotation" title with number and version), the DEMO watermark
 * strip, a facts strip (prepared for, issued, valid until), scope and timeline side by side, the
 * line items, then the totals card with terms beside it, and the footer with the notice and hash.
 */
import { brandDeclarations, brandPalette, senderInitials } from './brand-palette';
import { QuoteIcon } from './icons';
import type { QuoteRenderModel } from '@/server/services/quotes/render-model';

/**
 * The quote's brand palette as a `:root` rule. The model validates the colour as #rrggbb and every
 * derived value is hex or a fixed rgba(), so it is safe to embed; the page CSP allows this exact
 * text by its hash (see viewCsp).
 */
export function quoteBrandCss(model: QuoteRenderModel): string {
  return `:root{${brandDeclarations(brandPalette(model.sender.brandColor))}}`;
}

export function QuoteDocument({ model }: { model: QuoteRenderModel }) {
  const t = model.totals;
  return (
    <article className="qd" aria-label={`Quotation ${model.quoteNumber} ${model.versionLabel}`}>
      <header className="qd-band">
        <div className="qd-head">
          <div className="qd-from">
            <span className="qd-mark" aria-hidden="true">
              {senderInitials(model.sender.name)}
            </span>
            <div>
              <p className="qd-sender">{model.sender.name}</p>
              {model.sender.gstin ? <p className="qd-gstin">GSTIN {model.sender.gstin}</p> : null}
            </div>
          </div>
          <div className="qd-meta">
            <h1 className="qd-title">Quotation</h1>
            <p className="qd-id">
              <span className="qd-number" data-field="quote-number">
                {model.quoteNumber}
              </span>{' '}
              <span className="qd-version" data-field="version">
                {model.versionLabel}
              </span>
            </p>
          </div>
        </div>
      </header>

      {model.watermark ? (
        <p className="qd-watermark" data-field="watermark">
          <QuoteIcon name="flask-conical" />
          {model.watermark}
        </p>
      ) : null}

      <dl className="qd-facts">
        <div>
          <dt>Prepared for</dt>
          <dd data-field="recipient">{model.recipient.name}</dd>
        </div>
        <div>
          <dt>Issued</dt>
          <dd>{model.issuedOn}</dd>
        </div>
        <div>
          <dt>Valid until</dt>
          <dd>
            <span data-field="valid-until">{model.validUntil}</span>
          </dd>
        </div>
      </dl>

      <div className="qd-body">
        <div className="qd-brief">
          <section className="qd-section">
            <h2 className="qd-label">Scope</h2>
            <p className="qd-pre">{model.scopeText}</p>
          </section>
          <section className="qd-section">
            <h2 className="qd-label">Timeline</h2>
            <p className="qd-pre">{model.timelineText}</p>
          </section>
        </div>

        <table className="qd-table">
          <caption className="qd-sr">Services</caption>
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col" className="qd-num">
                Qty
              </th>
              <th scope="col" className="qd-num">
                Unit price
              </th>
              <th scope="col" className="qd-num">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {model.lines.map((line) => (
              <tr key={line.position}>
                <td>
                  <span className="qd-line-name">{line.name}</span>
                  <span className="qd-line-unit">
                    <span className="qd-line-rate">{line.unitPrice} </span>per {line.unitLabel}
                  </span>
                </td>
                <td className="qd-num">{line.qty}</td>
                <td className="qd-num">{line.unitPrice}</td>
                <td className="qd-num qd-amount">{line.lineTotal}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="qd-summary">
          <dl className="qd-totals">
            <div>
              <dt>Subtotal</dt>
              <dd data-field="subtotal">{t.subtotal}</dd>
            </div>
            {t.discount ? (
              <div>
                <dt>{t.discountLabel}</dt>
                <dd data-field="discount">-{t.discount}</dd>
              </div>
            ) : null}
            {t.tax ? (
              <>
                <div>
                  <dt>Taxable amount</dt>
                  <dd data-field="taxable">{t.taxable}</dd>
                </div>
                <div>
                  <dt data-field="tax-label">{t.taxLabel}</dt>
                  <dd data-field="tax">{t.tax}</dd>
                </div>
              </>
            ) : null}
            <div className="qd-total">
              <dt>Total</dt>
              <dd data-field="total">{t.total}</dd>
            </div>
          </dl>

          {model.sender.termsText ? (
            <section className="qd-section qd-terms">
              <h2 className="qd-label">Terms</h2>
              <p className="qd-pre qd-muted">{model.sender.termsText}</p>
            </section>
          ) : null}
        </div>
      </div>

      <footer className="qd-foot">
        <span data-field="notice">{model.notice}</span>
        <span className="qd-ref">
          {model.quoteNumber} {model.versionLabel} <span className="qd-mono" data-field="short-hash">{model.shortHash}</span>
        </span>
      </footer>
    </article>
  );
}
