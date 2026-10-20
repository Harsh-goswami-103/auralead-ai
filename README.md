# AuraLead AI

AuraLead AI turns incoming leads into approved, server-priced quotations for Indian service
businesses, and messages customers on WhatsApp and email only when consent allows it. Each lead is
normalized, de-duplicated, scored with its reasons and drafted for; a person approves a quotation
priced from the workspace's own price list, the worker renders its PDF, and the customer opens and
accepts it from a share link. Nothing reaches a customer without an approval, and every send is
checked against consent, the 24-hour WhatsApp window, opt-outs and pauses at the moment it goes out.

The app runs in one of two modes, each with its own database:

- **DEMO**: seeded businesses and identities, source and customer simulators, and demo transports.
  It makes no outbound request at all.
- **LIVE**: real accounts by invitation, HTTPS only, provider integrations per workspace. It refuses
  to start without its secrets.

Status: see [docs/progress.md](docs/progress.md). Provider integrations and what has been verified
against each provider: [docs/integrations.md](docs/integrations.md).

## Quick start (DEMO)

Requires Node.js 22.23.2 (`.nvmrc`) and npm 10.9.8.

```bash
npm ci
npm run setup
npm run db:reset
npm run dev:all
```

Open http://localhost:3000 and choose a demo identity on the sign-in page. The in-app guide at
`/docs/getting-started` walks a simulated lead all the way to an accepted quotation.

For a real deployment, follow `/docs/going-live` and [docs/deployment.md](docs/deployment.md).

## Scripts

The verified command list, with the project rules, is in [CLAUDE.md](CLAUDE.md). The ones you will
use most:

| Command | What it does |
|---|---|
| `npm run setup` | Writes `.env` from `.env.example` and generates the secrets; never overwrites an existing key |
| `npm run db:path` | Prints the SQLite file this configuration uses (`--json` for every path) |
| `npm run db:deploy` | Applies the migrations (`prisma migrate deploy`) |
| `npm run db:migrate` | Creates and applies a migration in development (`prisma migrate dev`) |
| `npm run db:seed` / `npm run db:reset` | Loads the DEMO seed / wipes the app tables and reseeds; both refuse LIVE |
| `npm run demo:refresh` | Moves the seeded DEMO dates to now without changing any id |
| `npm run dev:all` | Next dev server and the worker together (`npm run dev` and `npm run worker` separately) |
| `npm run build` | Generates the database client, builds the app, bundles the worker into `dist/worker.js` |
| `npm run start` / `npm run start:worker` | Runs the built app and the built worker |
| `npm run admin:bootstrap` | LIVE: prints a single-use invite for the first administrator (`--recover` for a lost password) |
| `npm run db:backup` / `npm run db:restore` | Consistent backup with a manifest / restore that pauses outbound and reconciles in-flight sends |
| `npm run lead:erase` | Erases one lead's personal data, keeping its opt-out |
| `npm run pipeline:resume` | Resumes pipeline stages that halted for want of a handler |
| `npm run typecheck` / `npm run lint` / `npm run test` | TypeScript, ESLint and the Vitest projects (unit, integration, components) |
| `npm run test:e2e` | Playwright against built DEMO and LIVE apps (Chromium) |
| `npm run verify` | The acceptance run: checks, tests, audit, Playwright and a fresh-copy setup |

## Documentation

In the app, `/docs` (public, no sign-in):

- `/docs/getting-started`: run the demo locally and walk a lead to an accepted quotation
- `/docs/going-live`: LIVE configuration, secrets, HTTPS, first administrator, build and run
- `/docs/roles-and-panels`: what owners, members, employees and super admins can do
- `/docs/lead-to-quote-workflow`: ingestion, scoring, drafts, approvals, quotations, PDF, sharing
- `/docs/messaging-rules`: consent, the 24-hour window, Stop, suppression, reason codes, pauses
- `/docs/security`: authentication, sessions, CSRF, CSP, isolation, rate limits, encryption, logging
- `/docs/data-and-privacy`: data locations, backups, restore, erasure, retention, DPDP notes
- `/docs/troubleshooting` and `/docs/limitations`

The pages are typed data in `content/docs/`; `tests/unit/docs/content.test.ts` fails when a page
names a script, env key, path, route or code that does not exist.

In this repository:

- [docs/architecture.md](docs/architecture.md): processes, layers, request flow, worker, outbox, modes
- [docs/deployment.md](docs/deployment.md): SQLite limits, storage, worker lifecycle, backups and
  restore, the PostgreSQL path
- [docs/runbooks.md](docs/runbooks.md): incident steps
- [docs/PRD.md](docs/PRD.md), [docs/implementation-plan.md](docs/implementation-plan.md),
  [docs/decisions.md](docs/decisions.md) (ADRs), [docs/progress.md](docs/progress.md)

## Layout

| Path | Contents |
|---|---|
| `src/app/` | Pages and route handlers (thin: parse, build the request context, call a service, map the result) |
| `src/server/` | Request context and auth, services (the only writers of state), adapters, jobs, database layer, PDF |
| `src/lib/` | Framework-free code: config, paths, money, phone numbers, errors, redaction |
| `src/components/` | UI: shadcn primitives, shared patterns, landing, visual effects |
| `worker/` | The worker process |
| `prisma/` | Schema, migrations and the deterministic DEMO seed |
| `scripts/` | Setup, backup, restore, erasure, bootstrap and verify scripts |
| `content/docs/` | The in-app documentation |
| `tests/` | Unit, integration, component and end-to-end tests |

Third-party code, fonts and licences: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
