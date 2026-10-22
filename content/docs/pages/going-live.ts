import type { DocPage } from '../format';

export const goingLive: DocPage = {
  slug: 'going-live',
  title: 'Go live',
  summary:
    'Deploy AuraLead AI for real use: configure LIVE mode, keep the generated secrets safe, serve it over HTTPS, create the database and the first administrator, and keep the web app and the worker running.',
  appliesTo: ['LIVE'],
  checked: '2026-10-20',
  sections: [
    {
      id: 'before-you-start',
      title: 'Before you start',
      blocks: [
        {
          kind: 'list',
          items: [
            'One server that runs Node.js 22 (`.nvmrc` pins 22.23.2) and npm 10, with a local disk for the data folder. Do not put the data folder in a synced folder such as OneDrive.',
            'A public HTTPS name and a reverse proxy that terminates TLS and forwards to the app. LIVE refuses to start on a plain-HTTP public origin, because the session cookie is Secure.',
            'Shell access to the server: the first administrator is created from the command line.',
            'A service manager to keep two processes running: the web app and the worker. Run one of each per mode; the database is one SQLite file and rate limits live in the web process memory.',
          ],
        },
      ],
    },
    {
      id: 'install',
      title: 'Install and generate secrets',
      blocks: [
        {
          kind: 'code',
          language: 'bash',
          caption: 'Install the pinned dependencies and write .env with fresh secrets',
          code: 'npm ci\nnpm run setup',
        },
        {
          kind: 'paragraph',
          text: '`npm run setup` copies `.env.example` to `.env` and generates `SESSION_SECRET`, `SHARE_NONCE_KEY`, `SUPPRESSION_PEPPER` and a one-key `CREDENTIALS_KEYRING` (key id `k1`, named by `CREDENTIALS_ACTIVE_KID`). It never overwrites a key that is already in `.env`. `.env` is the only environment file; real environment variables take precedence over it.',
        },
      ],
    },
    {
      id: 'environment',
      title: 'Configure .env for LIVE',
      blocks: [
        {
          kind: 'code',
          language: 'env',
          caption: 'The lines to change in .env (example origin)',
          code: 'APP_MODE=live\nNEXT_PUBLIC_APP_MODE=live\nAPP_ORIGIN=https://leads.example.in\nAURALEAD_TEST_CONTROL=0\nAUTH_COOKIE_INSECURE_DEV=0\nTRUSTED_PROXY_HOPS=1',
        },
        {
          kind: 'table',
          caption: 'Every key in .env',
          head: ['Key', 'Purpose', 'Required in LIVE'],
          rows: [
            ['`APP_MODE`', '`live` for a real deployment. One process serves one mode and opens that mode\'s database.', 'Yes: `live`'],
            ['`NEXT_PUBLIC_APP_MODE`', 'The mode compiled into the browser bundle; must equal `APP_MODE`.', 'Yes: `live`, before `npm run build`'],
            ['`APP_ORIGIN`', 'The public origin people use. Mutating requests must come from it, and printed invite and reset links start with it.', 'Yes: `https://...`'],
            ['`AURALEAD_DATA_DIR`', 'Base data folder; the mode folder (`live`) is added under it.', 'No (default per OS)'],
            ['`DATABASE_URL`', 'Optional SQLite `file:` URL for the database file.', 'No'],
            ['`STORAGE_DIR`', 'Folder for quotation PDFs (default `storage` in the mode folder).', 'No'],
            ['`BACKUP_DIR`', 'Folder `npm run db:backup` writes to (default `backups` in the mode folder).', 'No'],
            ['`SESSION_SECRET`', 'Signs CSRF tokens and unsubscribe links, and keys the client IP hashes. At least 32 characters.', 'Yes'],
            ['`SHARE_NONCE_KEY`', 'Signs the accept form of public quotation pages. At least 32 characters.', 'Yes'],
            ['`SUPPRESSION_PEPPER`', 'Key of the contact HMAC that suppression and consent records are stored under. At least 32 characters.', 'Yes'],
            ['`CREDENTIALS_KEYRING`', 'JSON object of key id to base64 32-byte AES key, for encrypted data at rest.', 'Yes'],
            ['`CREDENTIALS_ACTIVE_KID`', 'The key id used for new encryptions; must exist in the key ring.', 'Yes'],
            ['`OUTBOUND_PAUSED`', '`1` holds every provider send at preflight until the processes restart without it.', 'No'],
            ['`AURALEAD_TEST_CONTROL`', 'Test clock endpoints for automated tests. LIVE refuses to start with `1`.', 'Must be `0`'],
            ['`TEST_CONTROL_TOKEN`', 'Token for the automated-test endpoints. Unused in LIVE.', 'No'],
            ['`META_APP_SECRET`', 'Checks the `X-Hub-Signature-256` of deliveries to the WhatsApp webhook.', 'Only to receive WhatsApp webhooks'],
            ['`META_VERIFY_TOKEN`', 'Answers the WhatsApp webhook subscription check.', 'Only to receive WhatsApp webhooks'],
            ['`META_GRAPH_VERSION`', 'Graph API version, written like `v24.0`. Validated when set.', 'No'],
            ['`META_MARKETING_VERSION`', 'Marketing API version, written like `v24.0`. Validated when set.', 'No'],
            ['`TRUSTED_PROXY_HOPS`', 'How many reverse proxies stand in front of the app; the client IP is read from X-Forwarded-For only when this is above 0.', 'Set it to your proxy count'],
            ['`AUTH_COOKIE_INSECURE_DEV`', '`1` drops the `__Host-` prefix and the Secure flag from the session cookie, for a plain-HTTP development host only.', 'Must be `0`'],
            ['`SEED_NOW`', 'Anchor time of the development seed. Unused in LIVE.', 'No'],
            ['`LOG_LEVEL`', 'Log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`); default `info`.', 'No'],
          ],
        },
      ],
    },
    {
      id: 'secrets-backup',
      title: 'Back up the secrets',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Copy `SUPPRESSION_PEPPER`, `CREDENTIALS_KEYRING` and `CREDENTIALS_ACTIVE_KID` (and the other secrets) to a password manager or another safe place off the server, and keep them together with your database backups. A restored database is only useful with the secrets it was written with.',
        },
        {
          kind: 'table',
          caption: 'What breaks when a secret is lost or changed',
          head: ['Secret', 'If it is lost or changed'],
          rows: [
            ['`SUPPRESSION_PEPPER`', 'Stored opt-outs and consent records can no longer be matched to a phone number or email address, so people who said Stop could be contacted again. LIVE refuses to start without it.'],
            ['`CREDENTIALS_KEYRING`', 'Everything encrypted with a missing key becomes unreadable.'],
            ['`SESSION_SECRET`', 'Open pages need a reload, and unsubscribe links in emails already sent stop working.'],
            ['`SHARE_NONCE_KEY`', 'A public quotation page that is already open must be reloaded before the customer can accept.'],
          ],
        },
        {
          kind: 'callout',
          tone: 'warning',
          text: 'Never commit `.env`. On Linux and macOS `npm run setup` creates it readable by its owner only.',
        },
      ],
    },
    {
      id: 'https',
      title: 'HTTPS and what LIVE refuses',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Serve the app only over HTTPS at the address in `APP_ORIGIN`. With an `https://` origin every page also gets Strict-Transport-Security and an upgrade-insecure-requests directive in its Content Security Policy. A LIVE process refuses to start when:',
        },
        {
          kind: 'list',
          items: [
            '`SESSION_SECRET`, `SHARE_NONCE_KEY`, `SUPPRESSION_PEPPER`, `CREDENTIALS_KEYRING` or `CREDENTIALS_ACTIVE_KID` is missing, or a secret is shorter than 32 characters;',
            'the key ring is not valid JSON, a key is not exactly 32 bytes, or the active key id is not in the ring;',
            '`NEXT_PUBLIC_APP_MODE` differs from `APP_MODE`;',
            '`AURALEAD_TEST_CONTROL=1`;',
            '`APP_ORIGIN` is plain `http://` on a host other than localhost, 127.0.0.1 or [::1]. `AUTH_COOKIE_INSECURE_DEV=1` lifts this for a development network only, and the app logs a warning.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'The worker exits at once with `worker failed to start:` and the reason. The web process answers every page with an error and logs `Invalid configuration:` or `Refusing to start:` with the list of problems. [Troubleshooting](/docs/troubleshooting#startup-refusals) lists the exact messages.',
        },
      ],
    },
    {
      id: 'database',
      title: 'Create the database',
      blocks: [
        {
          kind: 'code',
          language: 'bash',
          caption: 'Apply the migrations to the LIVE database and show where it is',
          code: 'npm run db:deploy\nnpm run db:path',
        },
        {
          kind: 'paragraph',
          text: '`npm run db:deploy` creates `app.db` in the LIVE data folder and applies every migration. `npm run db:seed` and `npm run db:reset` are development tools: they refuse a LIVE process. The worker refuses to start while a migration is pending.',
        },
      ],
    },
    {
      id: 'first-admin',
      title: 'Create the first administrator',
      blocks: [
        {
          kind: 'code',
          language: 'bash',
          caption: 'Print a single-use invite link for the first administrator',
          code: 'npm run admin:bootstrap -- --email admin@yourcompany.in',
        },
        {
          kind: 'ordered',
          items: [
            'Run it on the server with the LIVE `.env`, after `npm run db:deploy`. It prints a link of the form `<APP_ORIGIN>/invite/<token>`, valid for 72 hours and usable once.',
            'Open the link in a browser and choose your name and a password of 12 to 256 characters. The command never sees a password; the link is shown once in the terminal and never logged.',
            'Sign in at `/login` with that email and password.',
          ],
        },
        {
          kind: 'list',
          items: [
            'It refuses once an active administrator exists, and for an email that already belongs to an account.',
            'Running it again before the link is used retires the earlier link.',
            'A lost administrator password is recovered from the same command with `--recover`: see [Troubleshooting](/docs/troubleshooting#locked-out).',
          ],
        },
      ],
    },
    {
      id: 'build-and-start',
      title: 'Build and start',
      blocks: [
        {
          kind: 'code',
          language: 'bash',
          caption: 'Build once, then start the web app and the worker',
          code: 'npm run build\nnpm run start\nnpm run start:worker',
        },
        {
          kind: 'list',
          items: [
            '`npm run build` generates the database client, builds the Next.js app and bundles the worker into `dist/worker.js`. Build after `.env` says `live`: the mode is compiled into the browser bundle.',
            '`npm run start` runs `next start`, on port 3000 unless you pass another port (`npm run start -- -p 8080`).',
            '`npm run start:worker` runs `node dist/worker.js`. Start it from the project folder: it compares `prisma/migrations` with the database and refuses to run with pending migrations.',
            'To update: stop both processes, install, run `npm run db:deploy` when the update brings migrations, `npm run build`, then start both again.',
          ],
        },
      ],
    },
    {
      id: 'supervision',
      title: 'Keep both processes running',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Register the web app and the worker with your service manager so they start at boot and restart when they exit. The worker stops claiming jobs on SIGINT, SIGTERM or SIGBREAK and lets the job in hand finish for up to 25 seconds. Correctness does not depend on a clean stop: a job whose worker vanished is claimed again when its 60-second lease runs out, and a send that may already have reached the provider is marked "Delivery unknown" instead of being sent again.',
        },
        {
          kind: 'list',
          items: [
            '`GET /api/health` answers 200 with the mode once the web process is configured and the database answers, and 503 when the database does not. It reveals nothing else.',
            'The worker writes a heartbeat every 10 seconds. Platform admin shows "Worker not running" when the last one is older than 30 seconds.',
          ],
        },
      ],
    },
    {
      id: 'reverse-proxy',
      title: 'Reverse proxy and client IPs',
      blocks: [
        {
          kind: 'list',
          items: [
            'Terminate TLS at the proxy and forward to the app (port 3000 by default) with the original Host, Origin and an X-Forwarded-For header.',
            'Set `TRUSTED_PROXY_HOPS` to the number of proxies in front of the app, usually `1`. The client IP used for rate limits is then the matching entry of X-Forwarded-For, counted from the right.',
            'Leave `TRUSTED_PROXY_HOPS=0` when there is no proxy. Otherwise anyone could send a made-up X-Forwarded-For and dodge the sign-in limits.',
            'The address in the browser must be exactly `APP_ORIGIN`: requests that change data are refused when their Origin differs.',
          ],
        },
      ],
    },
    {
      id: 'data-folder',
      title: 'The data folder',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Everything the app writes lives in one folder per mode: `%LOCALAPPDATA%\\auralead\\live\\` on Windows, `~/.local/share/auralead/live/` (or under `$XDG_DATA_HOME`) elsewhere, or the `live` folder under `AURALEAD_DATA_DIR`. `npm run db:path -- --json` prints every resolved path.',
        },
        {
          kind: 'table',
          caption: 'Contents of the LIVE data folder',
          head: ['Path', 'What it holds'],
          rows: [
            ['`app.db`', 'The SQLite database (with its `-wal` and `-shm` files while running).'],
            ['`storage/`', 'Quotation PDFs, unless `STORAGE_DIR` points elsewhere.'],
            ['`backups/`', 'Database backups, unless `BACKUP_DIR` points elsewhere.'],
            ['`journal/`', 'The suppression journal: every Stop and opt-in clear, kept outside the database so a restore cannot lose it.'],
            ['`outbound.lock`', 'Present only while outbound is paused by a restore or by an operator.'],
          ],
        },
        {
          kind: 'paragraph',
          text: 'Back up the database with `npm run db:backup` on a schedule, and copy the storage folder and the journal with it. [Data and privacy](/docs/data-and-privacy#backups) covers backups and restores.',
        },
      ],
    },
    {
      id: 'first-sign-in',
      title: 'First sign-in',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Sign in at `/login`. An administrator lands on Platform admin (`/dashboard/admin`): worker liveness, the outbound delivery state and account counts, with links to Jobs and queue and to Webhooks. Administrator sessions end after 12 hours, and pausing outbound or acting on a job asks for your password again when your last sign-in is more than 15 minutes old. [Roles and panels](/docs/roles-and-panels) and [Security](/docs/security) describe what each role can do and how accounts are protected.',
        },
      ],
    },
  ],
};
