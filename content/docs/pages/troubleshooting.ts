import type { DocPage } from '../format';

export const troubleshooting: DocPage = {
  slug: 'troubleshooting',
  title: 'Troubleshooting',
  summary:
    'The symptoms you are most likely to meet and their real fixes: start-up refusals, OneDrive warnings, sign-in lockouts, a stopped worker, stuck jobs, paused outbound, refused sends, a busy database and refused restores.',
  appliesTo: ['DEMO', 'LIVE'],
  checked: '2026-10-23',
  sections: [
    {
      id: 'startup-refusals',
      title: 'The app or the worker refuses to start',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Configuration is checked when a process starts. The worker exits with `worker failed to start:` and the reason. The web process answers pages with an error and logs `Invalid configuration:` or `Refusing to start:` followed by every problem it found. Secrets are never echoed in these messages.',
        },
        {
          kind: 'table',
          caption: 'Start-up messages and fixes',
          head: ['Message contains', 'Cause', 'Fix'],
          rows: [
            ['`to generate them into .env`', '`.env` is missing or lacks the generated secrets.', 'Run `npm run setup`. It adds the missing keys and keeps every existing one.'],
            ['`required in LIVE mode`', 'A LIVE process lacks one of the required secrets.', 'Restore the key from your secrets backup. Generate a new one only on a fresh installation: see [Back up the secrets](/docs/going-live#secrets-backup).'],
            ['`must be at least`', 'A secret is shorter than 32 characters, for example shortened or typed by hand.', 'Restore the original value.'],
            ['`must equal APP_MODE`', '`NEXT_PUBLIC_APP_MODE` and `APP_MODE` differ.', 'Set both to the same mode, then run `npm run build` again: the browser bundle has the mode compiled in.'],
            ['`must not be enabled in LIVE mode`', '`AURALEAD_TEST_CONTROL=1` in LIVE.', 'Set `AURALEAD_TEST_CONTROL=0`.'],
            ['`LIVE must be served over https`', '`APP_ORIGIN` is plain HTTP on a public host.', 'Use the `https://` origin people reach. Only on a trusted development network, `AUTH_COOKIE_INSECURE_DEV=1` lifts it.'],
            ['`CREDENTIALS_KEYRING:`', 'The key ring is not valid JSON, is empty, or holds a key that is not base64 of exactly 32 bytes.', 'Restore the original line; in `.env` the JSON stays in single quotes.'],
            ['`must name a key present in CREDENTIALS_KEYRING`', '`CREDENTIALS_ACTIVE_KID` names a key that is not in the ring.', 'Set it to a key id that is in the ring.'],
            ['`pending migrations` (worker)', 'The code has migrations the database has not applied.', 'Stop the web app and the worker, run `npm run db:deploy`, start both again.'],
          ],
        },
      ],
    },
    {
      id: 'onedrive-warning',
      title: 'A OneDrive warning at start',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The message says a database, storage, backups or journal path "is inside a OneDrive folder". OneDrive corrupts SQLite write-ahead files and uploads personal data. Set `AURALEAD_DATA_DIR` to a local folder, check it with `npm run db:path`, and move the existing data folder there while the app and the worker are stopped.',
        },
      ],
    },
    {
      id: 'locked-out',
      title: 'Sign-in keeps failing',
      blocks: [
        {
          kind: 'list',
          items: [
            'Every failure answers "Email or password is incorrect.", including a locked account, so the answer itself never tells you which it is.',
            '5 failed sign-ins in a row lock the account for 15 minutes, even for the right password. Wait for the lock to end, then sign in with the right password.',
            '"Too many requests. Wait a moment and try again." means the per-address or per-account rate limit (5 a minute) was hit: wait a minute.',
            'An administrator who lost the password: on the server run `npm run admin:bootstrap -- --recover --email <address>`. It prints a one-hour, single-use reset link (`/reset/<token>`); using it sets the new password, lifts the lock and signs the account out everywhere.',
            'Only active accounts can sign in.',
          ],
        },
      ],
    },
    {
      id: 'session-not-kept',
      title: 'Signed in, but the next page asks to sign in again',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The browser did not store the session cookie. It is Secure and `__Host-` prefixed, so browsers keep it only over HTTPS or on localhost. Serve the app over HTTPS at exactly `APP_ORIGIN`. For a plain-HTTP development host on another machine, `AUTH_COOKIE_INSECURE_DEV=1` drops the prefix and the Secure flag; never in production.',
        },
      ],
    },
    {
      id: 'worker-not-running',
      title: 'Nothing happens after an action',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Leads are not ingested, scores, drafts or PDFs never appear, and the lead console says the worker has not processed the queued events yet. Platform admin shows "Worker not running" when the worker\'s last heartbeat is older than 30 seconds.',
        },
        {
          kind: 'list',
          items: [
            'Start the worker: `npm run worker` in development (or `npm run dev:all` for both processes), `npm run start:worker` after `npm run build`.',
            'If it exits at once, read its last line: `worker failed to start:` names the reason (see [above](#startup-refusals)).',
            'Both processes must use the same `.env` and the same data folder; `npm run db:path` run from the project folder shows which database they open.',
          ],
        },
      ],
    },
    {
      id: 'stuck-jobs',
      title: 'Jobs stuck, retrying or dead',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Open Jobs and queue (`/dashboard/admin/jobs`) as a super admin. The status tiles and filters show what is due, running, waiting to retry, dead and of unknown delivery; each job opens in the inspector with its redacted payload, its attempts and the correlation timeline.',
        },
        {
          kind: 'list',
          items: [
            '**Waiting to retry:** a failed attempt is retried with growing delays; deferrals (a pause or an internal cap) wait without using up attempts. Nothing to do unless it keeps failing.',
            '**Running too long:** a job whose worker died is claimed again when its 60-second lease runs out. Nothing to do.',
            '**Dead:** the job used up its attempts (5 for sends, 3 for AI drafts and PDFs, 8 for website checks, 5 for the rest) or hit a permanent error; the inspector shows the redacted error. **Retry** requeues a job that has no provider side effects. A dead send is retried only as a new attempt, and only when the last attempt definitely did not send.',
            '**Delivery unknown:** see [below](#delivery-unknown).',
            'A pipeline halted at a stage that had no handler yet (`STAGE_HANDLER_MISSING`) is resumed with `npm run pipeline:resume`.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Every inspector action asks for a reason and a sign-in within the last 15 minutes, and is audited.',
        },
      ],
    },
    {
      id: 'delivery-unknown',
      title: 'Delivery unknown',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A send is `AMBIGUOUS` ("Delivery unknown") when it may or may not have reached the provider: a timeout after the request was written, a worker that died mid-send, or a restore that found it queued or in flight. It is never sent again automatically. A matching delivery status from the provider settles it; otherwise open the job and choose **Mark delivered** (you have evidence it arrived), **Verified not delivered**, or **Not delivered: resend**, which needs the typed confirmation `RESEND` and runs every send check again.',
        },
      ],
    },
    {
      id: 'outbound-paused',
      title: 'Nothing is being sent',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A red banner says "Outbound paused globally by admin. No message or provider action will be sent." Platform admin and Jobs and queue show which of the three switches holds it.',
        },
        {
          kind: 'table',
          caption: 'Lifting each pause switch',
          head: ['Switch', 'Lift it by'],
          rows: [
            ['Admin switch', '**Resume outbound** in Jobs and queue, with a reason and a recent sign-in.'],
            ['`outbound.lock` written by a restore', 'The same **Resume outbound**, after reviewing the "Delivery unknown" sends; it removes the lock.'],
            ['`outbound.lock` created by hand', 'Deleting the file from the data folder. Resuming in the panel leaves a hand-made lock alone.'],
            ['`OUTBOUND_PAUSED=1`', 'Setting `OUTBOUND_PAUSED=0` (or removing it) and restarting the web app and the worker.'],
          ],
        },
        {
          kind: 'paragraph',
          text: 'A yellow banner "Automation paused in ..." pauses only automated sends of one workspace. If nothing is paused and a send still does not go, its reason code says why: see [Eligibility reason codes](/docs/messaging-rules#reason-codes).',
        },
      ],
    },
    {
      id: 'send-refused',
      title: 'A send is refused or skipped',
      blocks: [
        {
          kind: 'list',
          items: [
            '`NO_WHATSAPP_OPT_IN`: there is no WhatsApp opt-in on record. Leads from the Maps extension, a Google Places search or a file import never have one of their own; record real evidence on the lead\'s reach-out panel, share your click-to-chat link so the customer writes first, or use another channel.',
            '`HANDED_OVER`: the lead was handed over to the client, so operators can no longer message it or change its conversations. The client continues; see [Reach out and hand over](/docs/reach-out-and-handoff#after-handoff).',
            '`WINDOW_CLOSED`: the 24-hour window is closed. Send an approved template or save the reply for review.',
            '`SUPPRESSED`: the contact said Stop or unsubscribed. Only a new opt-in collected after the Stop clears it.',
            '`APPROVAL_STALE`: something in the message changed after it was approved. Approve the current version again.',
            '`NOT_CONFIGURED` (LIVE): the channel has no connected integration.',
          ],
        },
      ],
    },
    {
      id: 'lead-generation',
      title: 'The finder, an import, a template or an automatic reply does not work',
      blocks: [
        {
          kind: 'list',
          items: [
            '**A search ends with an error code.** `PLACES_AUTH`: Google rejected the key, so save a valid one on the Google Places integration page. `PLACES_PERMISSION`: switch on the Places API (New) and billing for the key\'s project, or lift the key\'s restrictions. `PLACES_RATE_LIMITED`, `PLACES_UNAVAILABLE` and `PLACES_UNREACHABLE`: Google throttled or did not answer, some searches were skipped and the run reads "Finished with gaps"; search again later. [Lead Finder](/docs/lead-finder#google-places) has the rest.',
            '**A new search is refused.** `FINDER_RUN_LIMIT` (409): two searches are already running in the workspace; cancel one or wait. A 429 means the limit of 10 new searches an hour was reached.',
            '**Results say "Details expired".** Google content is a 24-hour copy. **Refresh details** fetches it again (a paid request, up to 10 results at a time, `finder.run` needed); imported leads keep their own copy for 30 days.',
            '**An import is refused with 422.** The reason code says why: a file that is too large or has too many rows or columns, the wrong type, no header or no data. The list is in [Import and export leads](/docs/import-and-export#import). A consent column that is ignored or refused is explained on the confirmation; a row without consent has its reason in the result.',
            '**An import stays on Importing.** The background worker is not running (see [Nothing happens after an action](#worker-not-running)). A job that died without reporting is ended as failed (`IMPORT_STALLED`) by the cleanup 24 hours after the upload.',
            '**A template stays on "Submitting to Meta".** The submission job or the follow-up sync has not run; check the worker. If Meta never received it, the sync returns the template to Draft after a minute (`NOT_FOUND_AFTER_SUBMIT`) and you submit again. A template with a PDF header is refused with `INTEGRATION_NOT_CONFIGURED` until the Meta app ID is saved on the WhatsApp integration.',
            '**A template was rejected.** The reason is shown on the template. Change the wording or the category, save it as a new template with a new name, and delete the rejected one (that also frees its name at Meta).',
            '**No automatic reply came.** Check, in order: the conversation is in Auto, **Automatic sending** is on for the workspace, a person has not taken the thread over, the lead was not handed over, the 24-hour window is open (`WINDOW_CLOSED`), the contact has not opted out, fewer than four automatic replies went out in a row (`REPLY_CAP`), and the message was a service question. Prices, calls, complaints and requests for a person always wait for a person; see [Inbox and automatic replies](/docs/inbox-and-ai-replies#what-ai-answers).',
            '**A hand-over is refused.** `ALREADY_HANDED_OVER`: it was done already. `LEAD_LOST` and `LEAD_MERGED`: move a lost lead back to an open stage, or hand over the lead it was merged into. `STAGE_VERSION_CONFLICT` and `MODE_VERSION_CONFLICT`: someone changed the lead or a conversation at the same moment; reload and try again, nothing was changed.',
          ],
        },
      ],
    },
    {
      id: 'database-busy',
      title: 'The system is busy',
      blocks: [
        {
          kind: 'paragraph',
          text: '"The system is busy. Try again in a moment." (`DB_BUSY`, HTTP 503) means another connection held the database write lock for longer than the 5-second wait, even after retries. SQLite allows one writer at a time across the web app and the worker.',
        },
        {
          kind: 'list',
          items: [
            'Close database browsers or scripts that keep a write transaction open on `app.db`.',
            'Run one web process and one worker per mode, not more.',
            'Keep the data folder on a local disk, out of synced folders and network shares.',
            'Retrying the action is safe: every change runs in one transaction that either fully commits or leaves nothing behind.',
          ],
        },
      ],
    },
    {
      id: 'windows-file-locks',
      title: 'EPERM on Windows during install or migration',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Windows locks the native SQLite and Prisma files that a running process holds. Stop the web app and the worker, then run `npm ci`, `npm run db:deploy` or `prisma generate` again.',
        },
      ],
    },
    {
      id: 'admin-bootstrap-refused',
      title: 'npm run admin:bootstrap refuses',
      blocks: [
        {
          kind: 'table',
          caption: 'Bootstrap messages',
          head: ['Message', 'Fix'],
          rows: [
            ['"An administrator already exists."', 'Sign in as that administrator. For a lost password, add `--recover --email <their address>`.'],
            ['"That email already belongs to another account."', 'Use an address that has no account yet.'],
            ['"No active administrator has that email address." (with `--recover`)', 'Check the address; `--recover` only works for an active administrator.'],
          ],
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: '"DEMO mode uses seeded identities." means the command ran with `APP_MODE=demo`: run it with the LIVE `.env` (`APP_MODE=live`).',
        },
      ],
    },
    {
      id: 'restore-refused',
      title: 'npm run db:restore refuses',
      blocks: [
        {
          kind: 'table',
          caption: 'Restore refusals (the command prints db:restore failed: and the message)',
          head: ['Message contains', 'Cause', 'Fix'],
          rows: [
            ['"sent a heartbeat"', 'The worker is running (`WORKER_RUNNING`).', 'Stop the worker and the web app, then run the restore again.'],
            ['"does not match this process\'s mode" or "the other mode"', 'The backup belongs to the other mode (`BACKUP_MODE_MISMATCH`).', 'Run the restore with the `.env` of the backup\'s mode.'],
            ['"does not match its manifest sha256"', 'The file changed after it was written (`BACKUP_CHECKSUM_MISMATCH`).', 'Use another backup.'],
            ['"this database lacks"', 'The backup has tables or migrations this database lacks (`BACKUP_NEWER_THAN_DATABASE`).', 'Update the app and run `npm run db:deploy` first.'],
            ['"quick_check"', 'SQLite\'s integrity check failed on the backup (`BACKUP_CORRUPT`).', 'Use another backup.'],
            ['"is missing" or "cannot read backup manifest"', 'The backup file or its manifest is gone (`BACKUP_FILE_MISSING`, `BACKUP_MANIFEST_INVALID`).', 'Check the path, or use `--latest`.'],
          ],
        },
        {
          kind: 'paragraph',
          text: 'A failed restore changes nothing in the database, and removes the lock it wrote when there was none before.',
        },
      ],
    },
  ],
};
