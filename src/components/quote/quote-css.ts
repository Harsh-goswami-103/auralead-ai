/**
 * Paper-theme styles for the quote document and the public quote page (plan §10: `--paper`,
 * `--ink-1`, `--ink-2`, `--rule`; status never by colour alone; design spec §6 "Public quote").
 * The public page is served as a self-contained document under a hash-based CSP, so these are
 * plain CSS, not Tailwind classes: no web fonts (system stack), no external images (gradients and
 * inline SVG only), no inline style attributes, and no closing tag inside the text.
 *
 * Look: a light canvas with a soft brand haze and a fading dot grid; the quote is a sheet of paper
 * whose header is a band in the workspace brand colour (contrast-checked, see brand-palette.ts),
 * then the facts strip, the brief, the line items with a tinted header, and a totals card with a
 * brand rule above the total. Money stays ink. Beside it (below on phones) sit the status card,
 * whose ribbon carries an icon and a label per state, and the acceptance card.
 *
 * Primary buttons carry the band's gradient (ink contrast holds on both stops), so the page has one
 * brand gesture: band, total rule, accept card hairline and the call to action.
 *
 * Motion (durations follow the app's enter token, about 480ms): one-time entrances only. The sheet
 * rises, then its header, facts and body follow in a short stagger; the band's sheen sweeps once;
 * the brand rule above the total draws in; the status icon pops and the accepted check draws; the
 * gone-page rings expand once. Buttons lift on hover and the primary one sheens once. All of it is
 * inside `prefers-reduced-motion: no-preference`, so a reduced-motion or printed page is static and
 * fully visible. Nothing counts up and nothing loops.
 *
 * Print: no canvas, no shadows, no filled band (the band becomes ink text over a brand rule), no
 * buttons or form, and rows, totals and the acceptance receipt never split.
 *
 * The brand values below are the neutral defaults; a quote page overrides them with its own hashed
 * `:root` rule (quoteBrandCss). Constant text only: nothing from data is ever interpolated here.
 */
import { brandDeclarations, brandPalette, NEUTRAL_BRAND } from './brand-palette';

const NEUTRAL_BRAND_DECLARATIONS = brandDeclarations(brandPalette(NEUTRAL_BRAND));

export const QUOTE_DOCUMENT_CSS = `
:root{color-scheme:light;--paper:#FFFFFF;--canvas:#F2F4F7;--ink-1:#111318;--ink-2:#4A5060;--ink-3:#6B7280;--rule:#E3E6EC;--rule-2:#C9CED7;--danger:#B42318;--success:#067647;--success-ink:#05603A;--success-wash:#ECFDF3;--success-line:#ABEFC6;--info:#175CD3;--info-wash:#EFF8FF;--info-line:#B2DDFF;--warning:#B54708;--warning-wash:#FFFAEB;--warning-line:#FEDF89;--demo-ink:#8A4200;--demo-line:#F5A15A;${NEUTRAL_BRAND_DECLARATIONS};--focus:var(--brand-text);--radius:16px;--ease-enter:cubic-bezier(.2,0,0,1);--ease-emph:cubic-bezier(.16,1,.3,1);--ease-ambient:cubic-bezier(.45,0,.55,1);--ease-exit:cubic-bezier(.4,0,1,1);--shadow-paper:0 1px 2px rgba(17,19,24,.05),0 10px 28px -14px rgba(17,19,24,.2),0 36px 72px -36px rgba(17,19,24,.26);--shadow-card:0 1px 2px rgba(17,19,24,.05),0 12px 28px -18px rgba(17,19,24,.22)}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{background:var(--canvas);color:var(--ink-1);font-family:Inter,"Segoe UI",system-ui,-apple-system,"Noto Sans",Arial,sans-serif;font-size:16px;line-height:1.5;-webkit-text-size-adjust:100%;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body{position:relative;margin:0;min-height:100vh;padding:40px 16px 64px;background:radial-gradient(72rem 30rem at 50% -12rem,var(--brand-haze),transparent 70%)}
body::before{content:"";position:absolute;inset:0 0 auto;height:460px;background-image:radial-gradient(rgba(17,19,24,.11) 1px,transparent 1.6px);background-size:22px 22px;-webkit-mask-image:linear-gradient(180deg,#000 0%,transparent 100%);mask-image:linear-gradient(180deg,#000 0%,transparent 100%);pointer-events:none}
a{color:var(--brand-text)}
a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.qp{position:relative;max-width:860px;margin:0 auto}
.qp-layout{display:grid;gap:20px;align-items:start}
.qp-side{display:flex;flex-direction:column;gap:16px;min-width:0}
.qp-icon{width:1em;height:1em;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.qd-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

.qd{position:relative;min-width:0;background:var(--paper);border:1px solid var(--rule);border-radius:var(--radius);box-shadow:var(--shadow-paper);overflow:hidden}
.qd-band{position:relative;isolation:isolate;overflow:hidden;padding:30px 32px 28px;color:var(--brand-ink);background:linear-gradient(115deg,var(--brand-band) 0%,var(--brand-band) 42%,var(--brand-band-2) 100%)}
.qd-band::before{content:"";position:absolute;z-index:-1;right:-150px;bottom:-250px;width:460px;height:460px;border-radius:50%;background:repeating-radial-gradient(circle at center,transparent 0 26px,var(--brand-line) 26px 27px);opacity:.55}
.qd-band::after{content:"";position:absolute;z-index:-1;inset:0;background:linear-gradient(105deg,transparent 35%,rgba(255,255,255,.2) 50%,transparent 65%);opacity:0;pointer-events:none}
.qd-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:20px 32px}
.qd-head p{margin:0}
.qd-from{display:flex;align-items:center;gap:16px;min-width:0}
.qd-mark{flex:none;display:grid;place-items:center;width:56px;height:56px;border-radius:16px;background:var(--brand-chip);border:1px solid var(--brand-line);font-size:20px;line-height:1;font-weight:700;letter-spacing:.02em}
.qd-sender{font-size:22px;line-height:28px;font-weight:700;letter-spacing:-.01em;overflow-wrap:anywhere}
.qd-gstin{margin-top:4px!important;font-size:13px;line-height:18px;font-weight:500;letter-spacing:.02em;font-variant-numeric:tabular-nums}
.qd-meta{text-align:right}
.qd-title{margin:0;font-size:36px;line-height:40px;font-weight:800;letter-spacing:-.035em}
.qd-id{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;margin-top:8px!important}
.qd-number{font-size:16px;line-height:22px;font-weight:700;font-feature-settings:"case"}
.qd-version{display:inline-flex;align-items:center;min-height:24px;padding:0 10px;border-radius:999px;background:var(--brand-chip);border:1px solid var(--brand-line);font-size:13px;font-weight:700}
.qd-watermark{display:flex;align-items:center;justify-content:center;gap:8px;margin:0;padding:10px 16px;border-bottom:1px dashed var(--demo-line);background:repeating-linear-gradient(-45deg,#FFF6EC 0 12px,#FFEEDC 12px 24px);color:var(--demo-ink);font-size:13px;line-height:18px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;text-align:center}
.qd-watermark .qp-icon{font-size:16px}
.qd-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0;border-bottom:1px solid var(--rule);background:linear-gradient(180deg,var(--brand-wash),var(--paper))}
.qd-facts>div{min-width:0;padding:18px 32px}
.qd-facts>div+div{border-left:1px solid var(--rule)}
.qd-facts dt,.qd-label{margin:0 0 6px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2)}
.qd-facts dd{margin:0;font-size:16px;line-height:22px;font-weight:600;overflow-wrap:anywhere}
.qd-body{padding:28px 32px 4px}
.qd-brief{display:grid;gap:22px}
.qd-section{min-width:0;margin:0}
.qd-section p{margin:0}
.qd-label{display:flex;align-items:center;gap:8px}
.qd-label::before{content:"";flex:none;width:14px;height:3px;border-radius:2px;background:var(--brand-text)}
.qd-pre{white-space:pre-line;overflow-wrap:anywhere}
.qd-muted{color:var(--ink-2);font-size:14px}
.qd-mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.qd-table{width:100%;margin-top:30px;border-collapse:separate;border-spacing:0;font-variant-numeric:tabular-nums}
.qd-table th{padding:10px 14px;border-top:1px solid var(--brand-soft);border-bottom:1px solid var(--brand-soft);background:var(--brand-wash);font-size:12px;line-height:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);text-align:left;white-space:nowrap}
.qd-table th:first-child{border-left:1px solid var(--brand-soft);border-radius:10px 0 0 10px}
.qd-table th:last-child{border-right:1px solid var(--brand-soft);border-radius:0 10px 10px 0}
.qd-table td{padding:16px 14px;border-bottom:1px solid var(--rule);vertical-align:top}
.qd-table th.qd-num,.qd-table td.qd-num,.qd-num{text-align:right;white-space:nowrap}
.qd-line-name{display:block;font-weight:600;overflow-wrap:anywhere;text-wrap:balance}
.qd-line-unit{display:block;margin-top:2px;color:var(--ink-2);font-size:13px;line-height:18px;text-wrap:balance}
.qd-line-rate{display:none}
.qd-amount{font-weight:600}
.qd-summary{display:grid;grid-template-areas:"totals" "terms";gap:24px;margin-top:24px}
.qd-totals{grid-area:totals;margin:0;padding:18px 20px;border:1px solid var(--rule);border-radius:14px;background:linear-gradient(180deg,#FAFBFC,var(--paper));font-variant-numeric:tabular-nums}
.qd-totals div{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:5px 0}
.qd-totals dt{color:var(--ink-2)}
.qd-totals dd{margin:0;white-space:nowrap}
.qd-total{position:relative;margin-top:10px;padding-top:14px!important;border-top:2px solid var(--brand-text)}
.qd-total dt{color:var(--ink-1);font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.qd-total dd{font-size:26px;line-height:32px;font-weight:800;letter-spacing:-.02em}
.qd-terms{grid-area:terms}
.qd-terms .qd-pre{font-size:14px;line-height:22px}
.qd-foot{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px 16px;margin:28px 32px 0;padding:16px 0 24px;border-top:1px solid var(--rule);color:var(--ink-2);font-size:13px;line-height:18px}
.qd-ref{display:inline-flex;flex-wrap:wrap;align-items:center;gap:8px}
.qd-foot .qd-mono{padding:2px 8px;border:1px solid var(--rule);border-radius:6px;background:#F5F6F8;color:var(--ink-1)}

.qp-card{position:relative;min-width:0;margin:0;padding:0;background:var(--paper);border:1px solid var(--rule);border-radius:var(--radius);box-shadow:var(--shadow-card);overflow:hidden}
.qp-card[data-tone=pending]{--tone-ink:var(--brand-text);--tone-wash:var(--brand-wash);--tone-line:var(--brand-soft);--tone-fill:var(--brand-band);--tone-on:var(--brand-ink)}
.qp-card[data-tone=approved]{--tone-ink:var(--info);--tone-wash:var(--info-wash);--tone-line:var(--info-line);--tone-fill:var(--info);--tone-on:#FFFFFF}
.qp-card[data-tone=accepted]{--tone-ink:var(--success);--tone-wash:var(--success-wash);--tone-line:var(--success-line);--tone-fill:var(--success);--tone-on:#FFFFFF}
.qp-ribbon{display:flex;align-items:center;gap:14px;padding:16px 20px;border-bottom:1px solid var(--tone-line);background:linear-gradient(100deg,var(--tone-wash),var(--paper))}
.qp-ribbon h2{margin:0;font-size:17px;line-height:22px;font-weight:700;letter-spacing:-.01em}
.qp-ribbon-k{display:block;margin-bottom:2px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--tone-ink)}
.qp-state{display:block}
.qp-colon{opacity:0}
.qp-ribbon-icon,.qp-head-icon{flex:none;display:grid;place-items:center;width:42px;height:42px;border-radius:13px;background:var(--tone-fill);color:var(--tone-on);font-size:22px;box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 6px 14px -8px rgba(17,19,24,.45)}
.qp-head-icon{background:var(--brand-wash);color:var(--brand-text);border:1px solid var(--brand-soft);box-shadow:none}
.qp-card-head{display:flex;align-items:center;gap:14px;padding:18px 20px 0}
.qp-card-head h2{margin:0;font-size:17px;line-height:22px;font-weight:700;letter-spacing:-.01em}
.qp-card-body{padding:18px 20px 20px}
.qp-actions{display:flex;flex-wrap:wrap;gap:10px}
.qp-actions .qp-button{flex:1 1 auto;white-space:nowrap}
.qp-button{position:relative;isolation:isolate;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 18px;border:1px solid transparent;border-radius:11px;background:linear-gradient(115deg,var(--brand-band) 0%,var(--brand-band) 35%,var(--brand-band-2) 100%) border-box;color:var(--brand-ink);font:inherit;font-size:15px;line-height:1.2;font-weight:600;text-align:center;text-decoration:none;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.2),0 1px 2px rgba(17,19,24,.14),0 8px 18px -12px rgba(17,19,24,.45)}
.qp-button::after{content:"";position:absolute;z-index:-1;inset:0;background:linear-gradient(105deg,transparent 30%,rgba(255,255,255,.32) 50%,transparent 70%);transform:translateX(-110%);pointer-events:none}
.qp-button:hover{background:var(--brand-band-2) border-box}
.qp-button .qp-icon{font-size:18px}
.qp-button.secondary{background:var(--paper);border-color:var(--rule-2);color:var(--brand-text);box-shadow:0 1px 2px rgba(17,19,24,.06)}
.qp-button.secondary::after{display:none}
.qp-button.secondary:hover{background:var(--brand-wash);border-color:var(--brand-text)}
.qp-button.wide{width:100%}
.qp-button[disabled]{opacity:.72;cursor:progress}
.qp-button[disabled]::before{content:"";width:16px;height:16px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%}
.qp-nowrap{white-space:nowrap}
.qp-note{margin:14px 0 0;color:var(--ink-2);font-size:14px;line-height:21px}
.qp-lead{margin:0;color:var(--ink-1);font-size:15px;line-height:23px}
.qp-receipt{display:flex;align-items:flex-start;gap:10px;margin:16px 0 0;padding:12px 14px;border:1px solid var(--success-line);border-radius:12px;background:var(--success-wash);color:var(--success-ink);font-size:14px;line-height:21px;font-weight:500}
.qp-receipt .qp-icon{margin-top:1px;font-size:18px;color:var(--success)}
.qp-field{display:flex;flex-direction:column;gap:6px;margin:18px 0 14px}
.qp-field label{font-size:14px;line-height:20px;font-weight:600}
.qp-input{width:100%;min-height:46px;padding:10px 14px;border:1px solid var(--ink-3);border-radius:11px;background:var(--paper);color:var(--ink-1);font:inherit;font-size:16px}
.qp-input:hover{border-color:var(--ink-2)}
.qp-status{min-height:20px;margin:10px 0 0;color:var(--ink-2);font-size:14px;line-height:20px}
.qp-status:empty{margin:0;min-height:0}
.qp-accept::before{content:"";position:absolute;inset:0 0 auto;height:3px;background:linear-gradient(90deg,var(--brand-band),var(--brand-band-2))}
#qp-accept{scroll-margin-top:24px}
.qp-mbar{position:fixed;z-index:10;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));max-width:560px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 8px 8px 16px;border:1px solid var(--rule);border-radius:16px;background:rgba(255,255,255,.94);-webkit-backdrop-filter:saturate(1.4) blur(12px);backdrop-filter:saturate(1.4) blur(12px);box-shadow:0 16px 36px -12px rgba(17,19,24,.32)}
.qp-mbar p{margin:0;display:flex;flex-direction:column;line-height:1.2;font-variant-numeric:tabular-nums}
.qp-mbar-k{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-2)}
.qp-mbar-v{font-size:17px;font-weight:800;letter-spacing:-.01em}
.qp-mbar[data-form-visible=true]{visibility:hidden;opacity:0;transform:translateY(130%);pointer-events:none}
.qp:has(.qp-mbar:not([hidden])){padding-bottom:84px}

.qp-center{display:flex;flex-direction:column;justify-content:center;min-height:calc(100vh - 104px);padding-bottom:4vh}
.qp-gone{position:relative;isolation:isolate;width:100%;max-width:560px;margin:0 auto;padding:44px 32px 34px;background:var(--paper);border:1px solid var(--rule);border-radius:20px;box-shadow:var(--shadow-paper);text-align:center;overflow:hidden}
.qp-gone::before{content:"";position:absolute;inset:0 0 auto;height:4px;background:linear-gradient(90deg,var(--brand-band),var(--brand-band-2))}
.qp-gone-icon{display:grid;place-items:center;width:64px;height:64px;margin:0 auto 22px;border:1px solid var(--brand-soft);border-radius:20px;background:var(--brand-wash);color:var(--brand-text);font-size:30px}
.qp-gone::after{content:"";position:absolute;z-index:-1;left:50%;top:76px;width:380px;height:380px;margin:-190px 0 0 -190px;border-radius:50%;background:repeating-radial-gradient(circle at center,transparent 0 16px,var(--ring) 16px 17px,transparent 17px 36px);-webkit-mask-image:radial-gradient(closest-side,#000 30%,transparent 92%),linear-gradient(180deg,#000 46%,transparent 62%);-webkit-mask-composite:source-in;mask-image:radial-gradient(closest-side,#000 30%,transparent 92%),linear-gradient(180deg,#000 46%,transparent 62%);mask-composite:intersect;pointer-events:none}
.qp-gone{--ring:var(--brand-soft)}
.qp-gone[data-tone=warning]{--ring:var(--warning-line)}
.qp-gone[data-tone=warning]::before{background:var(--warning)}
.qp-gone[data-tone=warning] .qp-gone-icon{border-color:var(--warning-line);background:var(--warning-wash);color:var(--warning)}
.qp-gone h1{margin:0 0 12px;font-size:26px;line-height:32px;font-weight:800;letter-spacing:-.025em;text-wrap:balance}
.qp-gone p{margin:0 auto 8px;max-width:440px;color:var(--ink-2);text-wrap:pretty}

@media (min-width:720px){
.qd-brief{grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:36px}
.qd-summary{grid-template-columns:minmax(0,1fr) minmax(280px,360px);grid-template-areas:"terms totals";align-items:start;gap:32px}
}
@media (min-width:720px) and (max-width:1079px){
.qp-side{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}
.qp-side>:only-child{grid-column:1/-1}
.qp-side>:only-child .qp-actions .qp-button{flex:0 1 auto;min-width:168px}
}
@media (min-width:1080px){
.qp{max-width:1200px}
.qp-layout{grid-template-columns:minmax(0,1fr) 340px;gap:28px}
.qp-side{position:sticky;top:24px}
.qp-mbar{display:none}
.qp:has(.qp-mbar:not([hidden])){padding-bottom:0}
}
@media (max-width:600px){
body{padding:20px 16px 48px}
.qd-band{padding:22px 20px 20px}
.qd-band::before{right:-200px;bottom:-280px}
.qd-head{flex-direction:column;align-items:flex-start;gap:18px}
.qd-mark{width:48px;height:48px;border-radius:14px;font-size:18px}
.qd-sender{font-size:19px;line-height:25px}
.qd-meta{text-align:left}
.qd-id{justify-content:flex-start}
.qd-title{font-size:30px;line-height:34px}
.qd-facts{grid-template-columns:repeat(2,minmax(0,1fr))}
.qd-facts>div{padding:14px 20px}
.qd-facts>div:first-child{grid-column:1/-1;border-bottom:1px solid var(--rule)}
.qd-facts>div+div{border-left:0}
.qd-facts>div:last-child{border-left:1px solid var(--rule)}
.qd-body{padding:22px 20px 4px}
.qd-table th,.qd-table td{padding-left:10px;padding-right:10px}
.qd-table th:nth-child(3),.qd-table td:nth-child(3){display:none}
.qd-line-rate{display:inline}
.qd-total dd{font-size:22px;line-height:28px}
.qd-foot{margin:24px 20px 0;padding:14px 0 20px}
.qp-card-body,.qp-ribbon{padding-left:16px;padding-right:16px}
.qp-card-head{padding-left:16px;padding-right:16px}
.qp-center{min-height:calc(100vh - 68px)}
.qp-gone{padding:36px 22px 28px}
.qp-gone::after{top:68px}
}

@media (prefers-reduced-motion:no-preference){
html{scroll-behavior:smooth}
.qd,.qp-gone{animation:qp-rise .5s var(--ease-emph) backwards}
.qd-from,.qd-meta{animation:qp-rise-sm .48s var(--ease-emph) backwards}
.qd-from{animation-delay:.08s}
.qd-meta{animation-delay:.12s}
.qd-watermark,.qd-facts,.qd-body,.qd-foot{animation:qp-fade .4s var(--ease-enter) backwards}
.qd-watermark{animation-delay:.12s}
.qd-facts{animation-delay:.15s}
.qd-body{animation-delay:.19s}
.qd-foot{animation-delay:.23s}
.qd-total{border-top-color:transparent}
.qd-total::before{content:"";position:absolute;left:0;right:0;top:-2px;height:2px;background:var(--brand-text);transform-origin:100% 50%;animation:qp-draw-x .7s .5s var(--ease-emph) backwards}
.qp-side>*{animation:qp-rise .5s var(--ease-emph) backwards}
.qp-side>:nth-child(1){animation-delay:.1s}
.qp-side>:nth-child(2){animation-delay:.16s}
.qd-band::after{animation:qp-sheen 1.5s .5s var(--ease-ambient) backwards}
.qp-gone::after{animation:qp-ripple .9s .2s var(--ease-emph) backwards}
.qp-ribbon-icon,.qp-gone-icon{animation:qp-pop .55s .32s var(--ease-emph) backwards}
.qp-card[data-tone=accepted] .qp-ribbon-icon .qp-draw{stroke-dasharray:18;animation:qp-draw .5s .62s var(--ease-enter) backwards}
.qp-mbar:not([hidden]){animation:qp-slide .48s .45s var(--ease-emph) backwards;transition:opacity .2s var(--ease-exit),transform .25s var(--ease-exit),visibility .25s}
.qp-button{transition:background-color .15s var(--ease-enter),border-color .15s var(--ease-enter),box-shadow .15s var(--ease-enter),transform .15s var(--ease-enter)}
.qp-button:hover{transform:translateY(-1px)}
.qp-button:hover::after,.qp-button:focus-visible::after{transform:translateX(110%);transition:transform .75s var(--ease-enter)}
.qp-button:active{transform:translateY(0) scale(.98);transition-duration:.09s}
.qp-input{transition:border-color .15s var(--ease-enter)}
.qp-button[disabled]::before{animation:qp-spin .8s linear infinite}
}
@keyframes qp-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes qp-rise-sm{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes qp-fade{from{opacity:0}to{opacity:1}}
@keyframes qp-draw-x{from{transform:scaleX(0)}to{transform:none}}
@keyframes qp-ripple{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
@keyframes qp-sheen{0%{opacity:0;transform:translateX(-110%)}25%{opacity:1}100%{opacity:0;transform:translateX(110%)}}
@keyframes qp-pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
@keyframes qp-draw{from{stroke-dashoffset:18}to{stroke-dashoffset:0}}
@keyframes qp-slide{from{opacity:0;transform:translateY(120%)}to{opacity:1;transform:none}}
@keyframes qp-spin{to{transform:rotate(360deg)}}

@media print{
@page{margin:14mm}
html,body{background:#FFFFFF!important}
body{min-height:0;padding:0}
body::before,.qd-band::before,.qd-band::after,.qd-total::before,.qp-gone::after,.qp-actions,.qp-accept,.qp-mbar,.qp-note,noscript{display:none!important}
*,*::before,*::after{animation:none!important;transition:none!important}
.qp,.qp-center{max-width:none;min-height:0;padding:0!important}
.qd-total{border-top-color:var(--brand-text)}
.qp-layout{display:block}
.qp-side{position:static;display:block;margin-top:18px}
.qd,.qp-card,.qp-gone{border:0;border-radius:0;box-shadow:none;overflow:visible}
.qd-band{padding:0 0 14px;background:none!important;color:var(--ink-1);border-bottom:3px solid var(--brand)}
.qd-mark{background:none;border:1.5px solid var(--brand);color:var(--ink-1)}
.qd-version{background:none;border-color:var(--rule-2)}
.qd-watermark{margin-top:12px;background:none;border:1px dashed var(--demo-line)}
.qd-facts{background:none}
.qd-facts>div{padding:12px 16px 12px 0}
.qd-facts>div+div{padding-left:16px}
.qd-body{padding:18px 0 0}
.qd-table th{background:none;border-top:0;border-left:0!important;border-right:0!important;border-radius:0!important;border-bottom:1.5px solid var(--ink-1)}
.qd-totals{background:none}
.qd-label::before{height:0;background:none;border-top:3px solid var(--brand-text)}
.qd-foot{margin:20px 0 0;padding:10px 0 0}
.qp-card{border-top:1px solid var(--rule)}
.qp-ribbon{padding:12px 0 0;background:none;border:0}
.qp-ribbon-icon{background:none;color:var(--tone-ink);border:1.5px solid var(--tone-ink);box-shadow:none}
.qp-card-body{padding:4px 0 0}
.qp-receipt{background:none}
.qd-table tr,.qd-facts,.qd-summary,.qd-totals,.qd-section,.qd-foot,.qp-card{break-inside:avoid}
}
`;
