# Integrations

One row per provider adapter, one section per provider. The matrix is parsed by `npm run verify` (P18): it prints every row and
checks that each evidence path cited in a *Live-verified* cell exists. Nothing is marked live-verified without evidence from a
user-authorized check against the real provider (plan section 13).

Column meanings:

- **Implemented**: the adapter, webhook or job exists and is wired into the registry.
- **Fixture-tested**: contract tests run the adapter against recorded or documented fixtures (no network).
- **Demo-verified**: the DEMO simulator exercises the same application services with zero outbound traffic.
- **Live-verified**: `<date> <evidence path>` once a person ran a check with real credentials; otherwise `No`.

## Status matrix

| Integration | Implemented | Fixture-tested | Demo-verified | Live-verified |
|---|---|---|---|---|
| WhatsApp Cloud API (send, templates, media) | Demo transport only | Error map only | Yes | No |
| WhatsApp webhooks (inbound, statuses) | Yes | Yes | Yes | No |
| Meta Lead Ads webhook and lead fetch | No | No | Yes | No |
| Meta Marketing API (metrics, pause/resume) | No | No | Yes | No |
| Resend (email send, webhooks) | Demo transport only | No | Yes | No |
| SMTP (nodemailer) | No | No | Yes | No |
| Google Sheets and Apps Script | No | No | Yes | No |
| Google_Map_Extractor bridge | No | No | Yes | No |
| Anthropic (drafts) | Yes | Yes | Yes | No |
| OpenAI (drafts) | Yes | Yes | Yes | No |

## Documentation check log

Plan rule (PRD working method 9): before building a live adapter, check the current official provider documentation, record the
links, the API version and the date here, and mark everything not confirmed as UNVERIFIED. Each integration task appends its own
section below. A check made only through search-result snippets, or against a cached copy, says so.

Environment note, 2026-10-20: the build environment's network policy blocks the provider documentation hosts
(`developers.facebook.com`, `resend.com`, `developers.google.com`), so first-hand reads of those pages were not possible. Web search
returned snippets only. Every behaviour below that came from snippets, from the earlier dated `error-map.ts` review (2026-10-16) or
from memory is marked UNVERIFIED and must be re-checked against the live documentation before a production go-live.
