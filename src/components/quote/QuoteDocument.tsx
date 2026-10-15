/**
 * The HTML presenter of a quote version (T16, C1). It renders exactly the render model that the
 * PDF presenter (src/server/pdf/QuotePdf.tsx) renders, so the page and the PDF carry the same
 * total, number, version and content hash (AT6). Pure and presentational: no hooks, no handlers,
 * so it renders both inside Next pages and through `renderStaticMarkup` for the public page.
 * Paper theme (plan §10); styles are in `QUOTE_DOCUMENT_CSS` (quote-css.ts), print included.
 * `data-field` attributes mark the values the parity test reads.
 */
import type { QuoteRenderModel } from '@/server/services/quotes/render-model';

/** The brand rule colour as CSS (the model validates it as #rrggbb, so it is safe to embed). */
export function quoteBrandCss(model: QuoteRenderModel): string {
  return `.qd{border-top-color:${/^#[0-9a-fA-F]{6}$/.test(model.sender.brandColor) ? model.sender.brandColor : '#111318'}}`;
}

export function QuoteDocument({ model }: { model: QuoteRenderModel }) {
  const t = model.totals;
  return (
    <article className="qd" aria-label={`Quotation ${model.quoteNumber} ${model.versionLabel}`}>
      {model.watermark ? (
        <p className="qd-watermark" data-field="watermark">
          {model.watermark}
        </p>
      ) : null}
      <header className="qd-head">
        <div>
          <p className="qd-sender">{model.sender.name}</p>
          {model.sender.gstin ? <p className="qd-muted">GSTIN {model.sender.gstin}</p> : null}
        </div>
        <div className="qd-meta">
          <h1 className="qd-title">Quotation</h1>
          <p>
            <span data-field="quote-number">{model.quoteNumber}</span> <span data-field="version">{model.versionLabel}</span>
          </p>
          <p className="qd-muted">Issued {model.issuedOn}</p>
          <p className="qd-muted">
            Valid until <span data-field="valid-until">{model.validUntil}</span>
          </p>
        </div>
      </header>

      <section className="qd-section">
        <h2 className="qd-label">Prepared for</h2>
        <p data-field="recipient">{model.recipient.name}</p>
      </section>

      <section className="qd-section">
        <h2 className="qd-label">Scope</h2>
        <p className="qd-pre">{model.scopeText}</p>
      </section>
      <section className="qd-section">
        <h2 className="qd-label">Timeline</h2>
        <p className="qd-pre">{model.timelineText}</p>
      </section>

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
                {line.name}
                <span className="qd-muted"> per {line.unitLabel}</span>
              </td>
              <td className="qd-num">{line.qty}</td>
              <td className="qd-num">{line.unitPrice}</td>
              <td className="qd-num">{line.lineTotal}</td>
            </tr>
          ))}
        </tbody>
      </table>

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
        <section className="qd-section">
          <h2 className="qd-label">Terms</h2>
          <p className="qd-pre qd-muted">{model.sender.termsText}</p>
        </section>
      ) : null}

      <footer className="qd-foot">
        <span data-field="notice">{model.notice}</span>
        <span>
          {model.quoteNumber} {model.versionLabel} <span className="qd-mono" data-field="short-hash">{model.shortHash}</span>
        </span>
      </footer>
    </article>
  );
}
