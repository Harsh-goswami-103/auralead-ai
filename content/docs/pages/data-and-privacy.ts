import type { DocPage } from '../format';

export const dataAndPrivacy: DocPage = {
  slug: 'data-and-privacy',
  title: 'Data and privacy',
  summary:
    'Where AuraLead keeps its data, how to back it up and restore it, how to erase a lead, what can be exported, how long things are kept, why suppression keys are pseudonymous, and notes on India\'s DPDP Act (not legal advice).',
  appliesTo: ['DEMO', 'LIVE'],
  checked: '2026-10-23',
  sections: [
    {
      id: 'where-data-lives',
      title: 'Where data lives',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Each mode has its own data folder, outside the project: `%LOCALAPPDATA%\\auralead\\<mode>\\` on Windows, `~/.local/share/auralead/<mode>/` (or under `$XDG_DATA_HOME`) elsewhere, or the mode folder under `AURALEAD_DATA_DIR`. `npm run db:path -- --json` prints every resolved path.',
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'DEMO and LIVE never share a database.',
        },
        {
          kind: 'table',
          caption: 'The data folder of one mode',
          head: ['Path', 'Contents', 'Override'],
          rows: [
            ['`app.db`', 'The SQLite database: workspaces, people, leads, consent, conversations, quotations, jobs and the audit log.', '`DATABASE_URL`'],
            ['`storage/`', 'Quotation PDFs at `quotes/<workspaceId>/<quoteVersionId>.pdf`, lead export files in `exports/`, the parsed rows of a file import in progress in `imports/`, and uploaded PDF brochures in `media/`.', '`STORAGE_DIR`'],
            ['`backups/`', 'Backups written by `npm run db:backup`, each with a manifest.', '`BACKUP_DIR`'],
            ['`journal/`', 'The suppression journal, one `suppressions-YYYYMMDD.jsonl` file per day.', 'None'],
            ['`outbound.lock`', 'Present only while outbound is paused by a restore or an operator.', 'None'],
          ],
        },
        {
          kind: 'callout',
          tone: 'warning',
          text: 'Keep the data folder out of OneDrive and other synced folders: syncing corrupts SQLite files and copies personal data to the cloud. The app and the worker warn at start when a path is inside OneDrive.',
        },
      ],
    },
    {
      id: 'what-is-stored',
      title: 'What is stored',
      blocks: [
        {
          kind: 'list',
          items: [
            '**Leads:** name, phone numbers, email address, website, address, city, PIN code, rating, review count and category, with the source record of every delivery (its raw payload stored redacted). A lead found with Google Places also keeps its place ID.',
            '**Lead Finder searches:** the keywords and locations, and for 24 hours the Google Maps content of each result (see [Retention](#retention)); afterwards only the place ID, the keyword and location, whether a website was listed, the emails found on the business\'s own website and the lead it was imported as.',
            '**File imports:** the counts, the row numbers with their reason codes (never the cell values), the data source and, for an attested consent column, the notice text and its hash. The rows themselves live in a file for at most 24 hours.',
            '**Consent:** basis, source, evidence and the time it was given, keyed by the contact hash. A recorded WhatsApp opt-in keeps the notice the customer saw, word for word, with its hash and how they agreed.',
            '**Templates and brochures:** the templates written in the studio with their submission history, and the PDF brochures uploaded for their headers.',
            '**Hand-overs:** the note the operator wrote, the AI summary and who acknowledged the handoff.',
            '**Conversations and messages:** the text of inbound and outbound messages, their delivery status and the provider message ids.',
            '**Quotations:** every version with its copy of the services and prices, the share link hashes, view events (a hashed IP and a browser class) and acceptances with the name the customer typed.',
            '**Audit log:** who did what and when, with field names but never personal values.',
            '**Webhook deliveries:** a redacted view, and an encrypted processing copy that is deleted on a schedule (see [Retention](#retention)).',
          ],
        },
      ],
    },
    {
      id: 'backups',
      title: 'Backups',
      blocks: [
        {
          kind: 'code',
          language: 'bash',
          caption: 'Take a consistent backup (safe while the app and the worker run)',
          code: 'npm run db:backup',
        },
        {
          kind: 'list',
          items: [
            'The backup is a SQLite `VACUUM INTO` copy, written as `auralead-<mode>-<time>.db` into the backup folder, followed by a `.json` manifest with the mode, the backup time, the size, the sha256 and the applied migrations. A manifest only exists for a complete backup.',
            'The database backup does not include the storage folder (quotation PDFs, export files, uploaded brochures): copy it alongside if you need the files. A restored database whose brochure files are gone reports `MEDIA_MISSING` when a template is submitted or sent; it never skips silently. The suppression journal is deliberately not part of a backup; a restore replays it.',
            'A backup is a full copy of personal data. Store it as carefully as the database, together with the secrets it needs (see [Go live](/docs/going-live#secrets-backup)). Backups are never deleted automatically: retire old ones yourself.',
          ],
        },
      ],
    },
    {
      id: 'restore',
      title: 'Restore',
      blocks: [
        {
          kind: 'code',
          language: 'bash',
          caption: 'Stop the web app and the worker, check, then restore the newest backup',
          code: 'npm run db:restore -- --latest\nnpm run db:restore -- --latest --yes',
        },
        {
          kind: 'ordered',
          items: [
            'Stop the web app and the worker. Without `--yes` the command only shows which backup it would restore. A specific backup is chosen with `--manifest <file.db.json>`.',
            'The restore checks the manifest, the mode and the sha256, then writes `outbound.lock` before changing anything, so no send can pass its preflight.',
            'In one transaction it replaces the data with the backup\'s, marks every send that was queued or in flight at backup time as "Delivery unknown" (`AMBIGUOUS`, reason `RESTORED_IN_FLIGHT`) so it is never sent again on its own, replays every suppression journal entry newer than the backup, and turns on the admin outbound pause.',
            'Start the app and the worker. Outbound stays paused. Review the "Delivery unknown" sends in Jobs and queue, then press **Resume outbound** there; resuming also removes the lock the restore wrote.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'The restore refuses while the worker\'s heartbeat is fresh (stop it first), a backup of the other mode, a file whose checksum does not match, and a backup with migrations this database does not have. [Troubleshooting](/docs/troubleshooting#restore-refused) lists the messages.',
        },
      ],
    },
    {
      id: 'erasure',
      title: 'Erasing a lead',
      blocks: [
        {
          kind: 'code',
          language: 'bash',
          caption: 'Erase one lead (prints what it would erase without --yes)',
          code: 'npm run lead:erase -- --workspace <slug> --lead <leadId> --reason "<request reference>" --yes',
        },
        {
          kind: 'list',
          items: [
            'In one transaction it deletes the lead, every lead merged into it and every row that carries their data: source records, consent records, conversations, messages, quotations and their share links, views and acceptances. Quotation PDF files are deleted after the commit.',
            'Matching webhook deliveries lose their processing copy and their inspector view, and the person\'s queued jobs are cancelled.',
            'The lead-generation data goes too. The lead\'s hand-over note and summary are deleted. Lead Finder results of the person\'s place (matched by the imported lead or by place ID) lose their Google content, their emails and their import link; they keep the place ID, keyword and location and read "Details removed on request", so a refresh never fetches the place again. Every import of the workspace that still holds a rows file is ended and the file deleted, because its rows cannot be matched to a person without reading them again. Lead exports, CSV or Excel, that may hold the person\'s row are ended and their files deleted.',
            'Suppressions stay, keyed by the contact hash, with the plain address removed: the person remains opted out.',
            'One `lead.erase` audit event records the counts and your reason. It holds no personal data, so make the reason a request reference, not a name.',
            'It refuses (`ERASE_SEND_IN_FLIGHT`) while a send to the lead is in progress; try again a moment later.',
          ],
        },
        {
          kind: 'callout',
          tone: 'limit',
          text: 'Erasure does not reach backups taken before it: the lead is in them until they are retired.',
        },
      ],
    },
    {
      id: 'exports',
      title: 'Exports',
      blocks: [
        {
          kind: 'list',
          items: [
            'Quotation PDFs can be downloaded by signed-in users from the lead page and the quotation, and by the customer from the shared page.',
            'Leads can be exported as CSV or Excel from the Leads page with the filters on screen. The file is prepared by a job, stays ready for 24 hours and is then deleted; it holds the lead columns as stored, so it is personal data to be handled like a backup. See [Import and export leads](/docs/import-and-export#lead-export).',
            'The Lead Finder\'s Excel file is built on request, never stored on the server, and available only to the person who started the search. In LIVE it holds place IDs, Google Maps links, the keyword and location, your own columns and website emails, and none of Google\'s content. See [Lead Finder](/docs/lead-finder#export).',
            'A database backup is a complete, self-contained SQLite file that standard SQLite tools can read.',
          ],
        },
      ],
    },
    {
      id: 'retention',
      title: 'Retention',
      blocks: [
        {
          kind: 'table',
          caption: 'How long data is kept',
          head: ['Data', 'Kept'],
          rows: [
            ['Webhook processing copy (the full, encrypted body)', 'Deleted 7 days after it was processed. A delivery that failed, was unrouted or was never processed keeps it until 30 days after it was received.'],
            ['Webhook inspector view (redacted)', 'Kept. Erasing a lead also removes the views of the deliveries that carried its data.'],
            ['Lead Finder results: Google Maps content', 'Removed 24 hours after it was fetched (name, business type, phone numbers, website, rating, review count, address, city, state, PIN code and attributions). The place ID, keyword, location, whether a website was listed, website emails and the import link stay. Latitude and longitude are never stored.'],
            ['Places fields on an imported lead', 'Removed 30 days after the import (phone numbers, rating, review count, address, PIN code and business type) unless the contact was confirmed. The name, city, website and place ID stay.'],
            ['Rows of a file import', 'The parsed rows file is deleted when the import finishes or fails, or 24 hours after the upload. Counts and reason codes stay on the import record.'],
            ['Lead export files', 'Ready for 24 hours, then deleted.'],
            ['Hand-over notes and summaries', 'Until the lead is erased with `npm run lead:erase`.'],
            ['Uploaded PDF brochures', 'Until you remove the files; the studio has no delete action for them yet.'],
            ['Leads, conversations, quotations, consent', 'Until erased with `npm run lead:erase`.'],
            ['Suppressions and the suppression journal', 'Kept, so that an opt-out keeps being honored. Erasure removes the plain contact, never the key.'],
            ['Audit log', 'Kept. It holds field names, not personal values.'],
            ['Backups', 'Until you delete them.'],
          ],
        },
      ],
    },
    {
      id: 'pseudonymous-keys',
      title: 'Pseudonymous suppression keys',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Suppressions and consent are stored under a contact key: HMAC-SHA256 of the normalized phone number or email address, keyed with `SUPPRESSION_PEPPER`. A plain hash of an Indian mobile number could be reversed by trying every number; without the pepper this key cannot be. It lets the app honor an opt-out after the lead is erased, while the plain number or address is gone.',
        },
        {
          kind: 'callout',
          tone: 'note',
          text: 'Keyed hashes are pseudonymous, not anonymous: whoever holds the pepper can match a known number to its key. Treat the pepper as a secret and back it up (losing it means stored opt-outs can no longer be matched).',
        },
      ],
    },
    {
      id: 'dpdp',
      title: 'India\'s DPDP Act',
      blocks: [
        {
          kind: 'callout',
          tone: 'warning',
          text: 'This section is not legal advice. It describes what the software records and does; whether that meets your obligations depends on your business, the final rules and your own legal advice.',
        },
        {
          kind: 'paragraph',
          text: 'The Digital Personal Data Protection Act, 2023 and its rules may place duties on a business that collects personal data, for example around notice, consent, purpose, erasure on request, safeguards and breach handling. AuraLead helps you keep evidence and act on requests:',
        },
        {
          kind: 'list',
          items: [
            'Consent records keep their source, the time it was given and the hash of the notice text the person saw. An opt-in recorded in the app also keeps the notice word for word and how the person agreed; an attested file import keeps the same for each row, with the attestation of the person who made it.',
            'Google Maps content is held for 24 hours, and on a lead for 30 days unless the contact is confirmed, so the app keeps as little of it as it can. This reduces risk; it is not a licence.',
            'Stop and unsubscribe are applied at once and survive erasure, restores and re-imports.',
            'A lead can be erased on request with `npm run lead:erase`, leaving only a tombstone with counts.',
            'Changes to leads, consent, quotations and sends are recorded in the audit log, and personal values are kept out of logs.',
          ],
        },
      ],
    },
  ],
};
