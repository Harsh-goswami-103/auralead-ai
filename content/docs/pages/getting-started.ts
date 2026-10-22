import type { DocPage } from '../format';

export const gettingStarted: DocPage = {
  slug: 'getting-started',
  title: 'Run the demo locally',
  summary:
    'Install AuraLead AI on your own machine, load the seeded demo businesses and walk a simulated lead all the way to an accepted quotation. Nothing in the demo contacts a real provider.',
  appliesTo: ['DEMO'],
  checked: '2026-10-22',
  sections: [
    {
      id: 'requirements',
      title: 'What you need',
      blocks: [
        {
          kind: 'list',
          items: [
            'Node.js 22.23.2, the version pinned in `.nvmrc` (`package.json` accepts 22.12 or newer, below 23), and npm 10.9.8.',
            'Windows 11 is the main target. The same commands work in PowerShell, Git Bash and on Linux or macOS.',
            'No provider accounts. In DEMO every WhatsApp, email and AI call goes to a built-in simulator, and the outbound network guard blocks every external host.',
          ],
        },
        {
          kind: 'callout',
          tone: 'note',
          text: 'The demo and a real deployment never share data: each mode has its own database and data folder. For a real deployment read [Go live](/docs/going-live).',
        },
      ],
    },
    {
      id: 'install',
      title: 'Install and configure',
      blocks: [
        {
          kind: 'code',
          language: 'bash',
          caption: 'Install, write .env, create and seed the demo database',
          code: 'npm ci\nnpm run setup\nnpm run db:reset',
        },
        {
          kind: 'list',
          items: [
            '`npm ci` installs the exact versions from `package-lock.json` and generates the database client. Use it instead of npm install.',
            '`npm run setup` writes `.env` from `.env.example` and generates the local secrets (`SESSION_SECRET`, `SHARE_NONCE_KEY`, `SUPPRESSION_PEPPER`, `CREDENTIALS_KEYRING` and `TEST_CONTROL_TOKEN`). It never overwrites a key that already exists, so running it again is safe. It prints the mode and the database file.',
            '`npm run db:reset` applies the migrations and loads the deterministic demo seed, replacing whatever the app tables held. It refuses to run against a LIVE process or a database that holds LIVE data.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'To keep an existing demo database instead, run `npm run db:deploy` (migrations only) and then `npm run db:seed`, which does nothing when the database is already seeded.',
        },
        {
          kind: 'callout',
          tone: 'note',
          text: 'The database is not in the project folder. On Windows it is `%LOCALAPPDATA%\\auralead\\demo\\app.db`; elsewhere `~/.local/share/auralead/demo/app.db` (or under `$XDG_DATA_HOME`). `npm run db:path` prints the file the app will use, and `AURALEAD_DATA_DIR` moves the whole folder.',
        },
      ],
    },
    {
      id: 'run',
      title: 'Start the app and the worker',
      blocks: [
        {
          kind: 'code',
          language: 'bash',
          caption: 'Web app and worker together',
          code: 'npm run dev:all',
        },
        {
          kind: 'paragraph',
          text: '`npm run dev:all` starts the Next.js development server and the background worker side by side. Open `http://localhost:3000` (the `APP_ORIGIN` in `.env`). You can also run them in two terminals with `npm run dev` and `npm run worker`.',
        },
        {
          kind: 'callout',
          tone: 'warning',
          text: 'Without the worker nothing that is queued happens: simulated leads are not ingested, and no score, draft or PDF appears. Pages that wait for the worker say so.',
        },
      ],
    },
    {
      id: 'demo-identities',
      title: 'Demo identities and panels',
      blocks: [
        {
          kind: 'paragraph',
          text: 'In DEMO, `/login` lists four seeded identities instead of a password form. The floating **Demo role** button at the bottom right switches identity on any page. None of this exists in a LIVE build.',
        },
        {
          kind: 'table',
          caption: 'Seeded identities',
          head: ['Identity', 'Person', 'Opens', 'Sees and does'],
          rows: [
            [
              '**Workspace owner**',
              'Ananya Sharma, owner of Smile Avenue Dental Clinic',
              'Client panel, `/dashboard/user`',
              'Command center for the workspace, Pricing, Quotations and the Inbox, with every capability in her own workspace.',
            ],
            [
              '**Codecraft client**',
              'Aarav Mehta, owner of Codecraft Web Studio',
              'Client panel, `/dashboard/user`',
              'The same client panel for a web-development studio in Indore: leads imported from a simulated Google Places search, their WhatsApp chats and one lead the operator has handed over, with every capability in his own workspace.',
            ],
            [
              '**Employee**',
              'Imran Qureshi',
              'Operator panel, `/dashboard/employee`',
              'Assignments, the lead console and approval queue of each assigned workspace: Smile Avenue Dental Clinic with the standard operator capabilities and a 10% discount cap, Kesari Crafts Online with a narrower set and a 15% cap, and Codecraft Web Studio with every capability except `consent.import` and a 10% cap (a fourth assignment is inactive).',
            ],
            ['**Super admin**', 'Meera Krishnan', 'Platform admin, `/dashboard/admin`', 'Global metrics, Jobs and queue (including the global outbound pause) and Webhooks. No tenant records.'],
          ],
        },
        {
          kind: 'paragraph',
          text: 'The seed holds six invented businesses: Smile Avenue Dental Clinic and Kesari Crafts Online (Delhi NCR), IronPulse Fitness Studio (Mumbai), NestKey Realty Advisors and PixelChai Design Studio (Bengaluru), and Codecraft Web Studio (Indore). Codecraft Web Studio also has a simulated WhatsApp connection with its own templates (approved, pending and rejected), a finished simulated Google Places search, leads with recorded WhatsApp opt-ins and open chats, and one lead handed over to its owner. Every contact uses a reserved test domain, so nothing is deliverable. [Roles and panels](/docs/roles-and-panels) describes each panel in full.',
        },
      ],
    },
    {
      id: 'walkthrough',
      title: 'Walk a lead to an accepted quote',
      blocks: [
        {
          kind: 'ordered',
          items: [
            'Choose **Employee** and press **Open lead console** on the Smile Avenue Dental Clinic card (`/dashboard/employee/<ws>/leads`).',
            'In **Simulate a lead source**, pick how many records to send (1 to 10) and press **Simulate** under **Google Sheets form row**, **Meta Lead Ads lead** or **Maps extension batch**. The simulated delivery goes through the same webhook storage and ingestion as a live source, and its records are labelled Simulated. Sheets rows carry a WhatsApp consent answer on every other row, Meta leads carry the form consent question, and Maps leads never carry WhatsApp consent.',
            'The worker normalizes and de-duplicates the records (a record whose phone or email matches an existing lead is counted as a duplicate and creates nothing), then runs the lead pipeline: score, then AI draft. The page refreshes itself while the worker has work, and each lead shows its score out of 100.',
            'Open a lead. **Pipeline** lists each stage it went through and **Draft** shows the draft. In DEMO drafts come from the local deterministic generator and no AI provider is called. **Generate draft** writes a fresh one.',
            'Under **Quotations**, press **Create quote from proposal**. The server prices the proposed services from the active price list (the AI never sets a price), so version 1 is a DRAFT with persisted totals. Press **Approve v1**. The worker renders the PDF, which you can download from the same card; demo PDFs carry the watermark "DEMO: not a valid offer".',
            'Switch to **Workspace owner**, open **Quotations** and the new quotation, press **Create share link** and then **Copy link**. Copying hands the quotation over and marks it Sent (**Mark as sent manually** does the same without a link). Open the link in a private window: the public quote page shows the quotation and lets the customer accept it by name.',
            'Open **Inbox** and use **Simulate customer message** (a text, a tap on Get quote, Request a call or Stop, or START) for a lead with a WhatsApp number. The inbound message opens the 24-hour window: write a reply and press **Send**. It goes to the demo WhatsApp transport and is labelled Simulated. Simulate **Taps "Stop"** and try again: the contact is suppressed and the send is refused.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'With the seeded pipeline (approval mode HUMAN), a draft that can be sent also becomes an item in the employee **Approvals** queue. Nothing reaches a customer until a person approves it. [Lead to quote](/docs/lead-to-quote-workflow) and [Messaging rules](/docs/messaging-rules) explain every step and every refusal.',
        },
      ],
    },
    {
      id: 'refresh',
      title: 'Keep the demo current',
      blocks: [
        {
          kind: 'code',
          language: 'bash',
          caption: 'Re-base the demo dates without changing any id',
          code: 'npm run demo:refresh',
        },
        {
          kind: 'paragraph',
          text: 'The seed writes its dates relative to an anchor time. After the demo has sat for a while, `npm run demo:refresh` moves every seeded date forward to now (or to `SEED_NOW`) without changing any id, so quotation validity and "days ago" facts look current again. `npm run db:reset` starts over and removes everything you created while exploring. Both refuse a LIVE process.',
        },
      ],
    },
    {
      id: 'windows-notes',
      title: 'Windows notes',
      blocks: [
        {
          kind: 'list',
          items: [
            'The project folder may contain spaces and may sit in OneDrive: quote paths in commands. The data folder defaults to `%LOCALAPPDATA%\\auralead\\demo\\`, outside OneDrive, because OneDrive corrupts SQLite WAL files. If any data path resolves inside OneDrive, the app and the worker log a warning; point `AURALEAD_DATA_DIR` at a local folder.',
            'Install with `npm ci` only, so every machine gets the exact pinned versions.',
            'Stop the web app and the worker before `npm run db:deploy`, `npm run db:migrate` or `prisma generate`: Windows locks the native SQLite files they hold (EPERM).',
            'Ctrl+C (and Ctrl+Break) stops the worker gracefully: it stops claiming jobs and finishes the one in hand. Ending it from Task Manager is safe too; a send that may already have reached the provider is marked "Delivery unknown" and is never repeated automatically.',
          ],
        },
      ],
    },
  ],
};
