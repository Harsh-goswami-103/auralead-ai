/**
 * Paper-theme styles for the quote document and the public quote page (plan §10: `--paper`,
 * `--ink-1`, `--ink-2`, `--rule`; status never by colour alone). The public page is served as a
 * self-contained document with a nonce'd <style>, so these are plain CSS, not Tailwind classes.
 * Print styling hides the page chrome and keeps rows whole (PRD: print styling).
 * Constant text only: nothing from data is ever interpolated here.
 */
export const QUOTE_DOCUMENT_CSS = `
:root{--paper:#FFFFFF;--ink-1:#111318;--ink-2:#4A5060;--rule:#E3E6EC;--accent:#0B7285;--danger:#B42318;--success:#067647}
*{box-sizing:border-box}
html{background:#F4F5F7;color:var(--ink-1);font-family:Inter,"Segoe UI",system-ui,-apple-system,"Noto Sans",Arial,sans-serif;font-size:16px;line-height:1.5;-webkit-text-size-adjust:100%}
body{margin:0;padding:24px 16px 48px}
.qp{max-width:860px;margin:0 auto}
.qp-banner{margin:0 0 16px;padding:8px 12px;border:1px solid #F5C08A;background:#FFF4E8;color:#7A3E00;border-radius:8px;font-size:14px}
.qp-panel{background:var(--paper);border:1px solid var(--rule);border-radius:12px;padding:24px;margin-top:16px}
.qp-panel h2{font-size:18px;line-height:26px;margin:0 0 8px}
.qp-actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.qp-button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.qp-button.secondary{background:var(--paper);color:var(--accent)}
.qp-button:focus-visible,.qp-input:focus-visible{outline:3px solid #2BC8DC;outline-offset:2px}
.qp-button[disabled]{opacity:.6;cursor:progress}
.qp-field{display:flex;flex-direction:column;gap:4px;margin:12px 0;max-width:420px}
.qp-input{min-height:44px;padding:8px 12px;border:1px solid #9AA1AE;border-radius:8px;font:inherit}
.qp-status{min-height:24px;margin:8px 0 0;font-size:14px;color:var(--ink-2)}
.qp-note{color:var(--ink-2);font-size:14px;margin:8px 0 0}
.qp-state{font-weight:600}
.qp-gone{max-width:560px;margin:48px auto;background:var(--paper);border:1px solid var(--rule);border-radius:12px;padding:32px}
.qp-gone h1{font-size:24px;line-height:32px;margin:0 0 12px}
.qp-gone p{margin:0 0 8px;color:var(--ink-2)}
.qd{position:relative;background:var(--paper);border:1px solid var(--rule);border-top:6px solid var(--ink-1);border-radius:12px;padding:32px;overflow:hidden}
.qd-watermark{margin:0 0 16px;padding:6px 10px;border:1px dashed #F5A15A;color:#9A4A00;font-weight:600;font-size:14px;text-align:center;letter-spacing:.04em;text-transform:uppercase}
.qd-head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:16px;border-bottom:1px solid var(--rule);padding-bottom:16px}
.qd-head p{margin:0}
.qd-sender{font-size:20px;line-height:28px;font-weight:600}
.qd-meta{text-align:right}
.qd-title{font-size:24px;line-height:32px;margin:0;letter-spacing:-.01em}
.qd-muted{color:var(--ink-2);font-size:14px}
.qd-mono{font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;font-size:13px}
.qd-section{margin-top:20px}
.qd-section p{margin:0}
.qd-label{font-size:12px;line-height:16px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2);margin:0 0 4px;font-weight:600}
.qd-pre{white-space:pre-line}
.qd-table{width:100%;border-collapse:collapse;margin-top:20px;font-variant-numeric:tabular-nums}
.qd-table th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2);text-align:left;border-bottom:1px solid var(--rule);padding:8px 6px}
.qd-table td{border-bottom:1px solid var(--rule);padding:10px 6px;vertical-align:top}
.qd-num{text-align:right;white-space:nowrap}
.qd-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.qd-totals{margin:16px 0 0 auto;max-width:360px;font-variant-numeric:tabular-nums}
.qd-totals div{display:flex;justify-content:space-between;gap:16px;padding:4px 0}
.qd-totals dt{color:var(--ink-2)}
.qd-totals dd{margin:0}
.qd-total{border-top:2px solid var(--ink-1);margin-top:6px;padding-top:8px!important;font-weight:600;font-size:18px}
.qd-total dt{color:var(--ink-1)}
.qd-foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;margin-top:24px;padding-top:12px;border-top:1px solid var(--rule);color:var(--ink-2);font-size:13px}
@media (max-width:600px){.qd{padding:20px}.qd-meta{text-align:left}.qd-table th:nth-child(3),.qd-table td:nth-child(3){display:none}}
@media print{html{background:#fff}body{padding:0}.qp-banner,.qp-panel,noscript{display:none!important}.qd{border:0;border-radius:0;padding:0}.qd-table tr{break-inside:avoid}.qd-totals{break-inside:avoid}}
`;
