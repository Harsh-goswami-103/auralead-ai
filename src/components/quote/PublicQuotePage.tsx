/**
 * The public quote page at /quote/[token] (T16, C2-C5), as one self-contained HTML document:
 *  - a live link shows the quote (QuoteDocument), the PDF download, print, and, for a SENT or
 *    VIEWED quote, the acceptance form carrying the form nonce and the expected version (C5);
 *  - an accepted quote shows the acceptance instead of the form;
 *  - an expired or superseded link shows the 410 page naming the sender; an invalid, revoked or
 *    cancelled link shows the one 404 page, identical in every case (C3).
 * The only script is the constant PAGE_SCRIPT (allowed by its CSP hash, see PUBLIC_QUOTE_CSP): the view beacon after 2 s of visibility
 * (C4), print, and a JSON submit of the acceptance form. Page data reaches it through data
 * attributes, never through script text.
 */
import { QUOTE_DOCUMENT_CSS } from './quote-css';
import { QuoteDocument, quoteBrandCss } from './QuoteDocument';
import { createHash } from 'node:crypto';
import type { QuoteRenderModel } from '@/server/services/quotes/render-model';

export type PublicQuoteState = 'APPROVED' | 'SENT' | 'VIEWED' | 'ACCEPTED';

export type PublicQuoteView =
  | {
      kind: 'quote';
      model: QuoteRenderModel;
      token: string;
      state: PublicQuoteState;
      accept: { formNonce: string; expectedVersionId: string } | null;
      acceptance: { acceptorName: string; acceptedOn: string; versionLabel: string } | null;
    }
  | { kind: 'gone'; reason: 'EXPIRED' | 'SUPERSEDED'; senderName: string }
  | { kind: 'not-found' }
  | { kind: 'error'; status: number };

/** Beacon, print and acceptance submit. Constant text: never interpolate data here. */
export const PAGE_SCRIPT = `(function(){
var s=document.currentScript,beacon=s&&s.getAttribute('data-beacon'),sent=false,timer=null;
function fire(){timer=null;if(sent||document.visibilityState!=='visible')return;sent=true;
var ok=false;try{ok=!!(navigator.sendBeacon&&navigator.sendBeacon(beacon,new Blob(['{}'],{type:'text/plain'})));}catch(e){ok=false;}
if(!ok){fetch(beacon,{method:'POST',headers:{'content-type':'application/json'},body:'{}',keepalive:true,credentials:'omit'}).catch(function(){});}}
function arm(){if(sent||timer||document.visibilityState!=='visible')return;timer=setTimeout(fire,2000);}
function disarm(){if(timer){clearTimeout(timer);timer=null;}}
if(beacon){document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'){arm();}else{disarm();}});arm();}
var p=document.querySelector('[data-action="print"]');if(p){p.hidden=false;p.addEventListener('click',function(){window.print();});}
var f=document.querySelector('form[data-accept]');if(f){f.addEventListener('submit',function(e){e.preventDefault();
var st=f.querySelector('[data-status]'),btn=f.querySelector('button[type="submit"]'),data={};
new FormData(f).forEach(function(v,k){data[k]=String(v);});btn.disabled=true;st.textContent='Recording your acceptance...';
fetch(f.getAttribute('action'),{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify(data),credentials:'omit'})
.then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};},function(){return {ok:r.ok,j:null};});})
.then(function(x){if(x.ok){window.location.reload();}else{st.textContent=(x.j&&x.j.message)||'The acceptance could not be recorded. Reload and try again.';btn.disabled=false;}})
.catch(function(){st.textContent='Network error. Check your connection and try again.';btn.disabled=false;});});}
})();`;

const cspHash = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/**
 * The page CSP. It uses no nonce, so every 404 body is byte-identical (C3): the shared style block
 * and the one script are constants allowed by their sha256 hashes, plus any extra style block the
 * page renders (the quote's brand rule, see viewCsp).
 */
export function publicQuoteCsp(extraStyles: readonly string[] = []): string {
  return [
  "default-src 'none'",
  `style-src ${[QUOTE_DOCUMENT_CSS, ...extraStyles].map(cspHash).join(' ')}`,
  `script-src ${cspHash(PAGE_SCRIPT)}`,
  "connect-src 'self'",
  "img-src 'self' data:",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');
}

const STATE_TEXT: Record<PublicQuoteState, string> = {
  APPROVED: 'Approved by the sender',
  SENT: 'Awaiting your response',
  VIEWED: 'Awaiting your response',
  ACCEPTED: 'Accepted',
};

function Shell({ title, children, script, extraStyle }: { title: string; children: unknown; script?: { beacon: string | null }; extraStyle?: string }) {
  return (
    <html lang="en-IN">
      {/* A standalone document rendered by renderStaticMarkup, not a Next page: next/head does not apply. */}
      {/* eslint-disable-next-line @next/next/no-head-element */}
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <meta name="referrer" content="no-referrer" />
        <title>{title}</title>
        <style>{QUOTE_DOCUMENT_CSS}</style>
        {extraStyle ? <style>{extraStyle}</style> : null}
      </head>
      <body>
        <main className="qp">{children as never}</main>
        {script ? (
          <script data-beacon={script.beacon ?? undefined}>
            {PAGE_SCRIPT}
          </script>
        ) : null}
      </body>
    </html>
  );
}

function QuoteView({ view }: { view: Extract<PublicQuoteView, { kind: 'quote' }> }) {
  const base = `/api/quote-share/${view.token}`;
  return (
    <>
      <QuoteDocument model={view.model} />
      <section className="qp-panel" aria-labelledby="qp-actions-title">
        <h2 id="qp-actions-title">
          Status: <span className="qp-state" data-field="state">{STATE_TEXT[view.state]}</span>
        </h2>
        <div className="qp-actions">
          <a className="qp-button secondary" href={`${base}/pdf`} download={`${view.model.quoteNumber}-${view.model.versionLabel}.pdf`}>
            Download PDF
          </a>
          <button type="button" className="qp-button secondary" data-action="print" hidden>
            Print
          </button>
        </div>
        {view.acceptance ? (
          <p className="qp-note" data-field="acceptance">
            Accepted by {view.acceptance.acceptorName} on {view.acceptance.acceptedOn} ({view.acceptance.versionLabel}).
          </p>
        ) : null}
        {view.state === 'APPROVED' ? <p className="qp-note">Acceptance opens once {view.model.sender.name} marks this quotation as sent to you.</p> : null}
        {view.accept ? (
          <form method="post" action={`${base}/accept`} data-accept="true" aria-labelledby="qp-accept-title">
            <h2 id="qp-accept-title">Accept this quotation</h2>
            <p className="qp-note">
              You are accepting {view.model.quoteNumber} {view.model.versionLabel} for {view.model.totals.total}, valid until {view.model.validUntil}.
            </p>
            <input type="hidden" name="token" value={view.token} />
            <input type="hidden" name="formNonce" value={view.accept.formNonce} />
            <input type="hidden" name="expectedVersionId" value={view.accept.expectedVersionId} />
            <div className="qp-field">
              <label htmlFor="qp-name">Your full name</label>
              <input id="qp-name" className="qp-input" name="acceptorName" autoComplete="name" required minLength={2} maxLength={120} />
            </div>
            <button type="submit" className="qp-button">
              Accept {view.model.quoteNumber} {view.model.versionLabel}
            </button>
            <p className="qp-status" data-status="true" role="status" aria-live="polite" />
            <noscript>
              <p className="qp-note">JavaScript is off. Download the PDF and reply to {view.model.sender.name} to accept.</p>
            </noscript>
          </form>
        ) : null}
      </section>
    </>
  );
}

export function PublicQuotePage({ view }: { view: PublicQuoteView }) {
  switch (view.kind) {
    case 'quote':
      return (
        <Shell title={`Quotation ${view.model.quoteNumber} ${view.model.versionLabel} from ${view.model.sender.name}`} script={{ beacon: view.state === 'ACCEPTED' ? null : `/api/quote-share/${view.token}/view` }} extraStyle={quoteBrandCss(view.model)}>
          <QuoteView view={view} />
        </Shell>
      );
    case 'gone':
      return (
        <Shell title={`Quotation from ${view.senderName} is no longer available`}>
          <section className="qp-gone">
            <h1>{view.reason === 'EXPIRED' ? 'This quotation link has expired' : 'This quotation has a newer version'}</h1>
            <p>
              {view.reason === 'EXPIRED'
                ? `The link from ${view.senderName} is past its validity date.`
                : `${view.senderName} has issued a newer version of this quotation, so this link no longer applies.`}
            </p>
            <p>Contact {view.senderName} for a current link.</p>
          </section>
        </Shell>
      );
    case 'not-found':
      return (
        <Shell title="Quotation not found">
          <section className="qp-gone">
            <h1>Quotation not found</h1>
            <p>This link is not valid. Check that you copied the whole link, or ask the sender for a new one.</p>
          </section>
        </Shell>
      );
    case 'error':
      return (
        <Shell title="Quotation unavailable">
          <section className="qp-gone">
            <h1>{view.status === 429 ? 'Too many requests' : 'Quotation unavailable'}</h1>
            <p>{view.status === 429 ? 'Wait a minute, then reload this page.' : 'Something went wrong while loading this quotation. Reload the page to try again.'}</p>
          </section>
        </Shell>
      );
  }
}

/** The CSP for a rendered view: the shared styles and script plus the quote's brand style. */
export function viewCsp(view: PublicQuoteView): string {
  return publicQuoteCsp(view.kind === 'quote' ? [quoteBrandCss(view.model)] : []);
}
