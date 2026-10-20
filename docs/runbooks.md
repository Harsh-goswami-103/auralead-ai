# Runbooks

Incident steps for an operator with shell access to the server and a super admin account. Each
runbook says when to use it, what to do, and how to check it worked. Background:
[deployment.md](deployment.md) and the in-app pages `/docs/troubleshooting` and
`/docs/data-and-privacy`. Checked against the code on 2026-10-20.

## Pause all outbound

Use it when sends may be wrong (a bad template or draft, a suspected data problem), during a
provider incident, or before any database work.

1. Platform admin, Jobs and queue (`/dashboard/admin/jobs`), **Pause all outbound**. Give a reason.
   If your last sign-in is older than 15 minutes, the dialog asks for your password first.
2. Without the panel, either switch also works:
   - create an empty `outbound.lock` file in the mode's data folder (`npm run db:path -- --json`
     prints its path); the worker sees it at the next preflight, no restart needed;
   - or set `OUTBOUND_PAUSED=1` in `.env` and restart the web app and the worker.

Effect: every send stops at its preflight with `GLOBAL_PAUSED` and waits in the queue. Sends already
`SENDING` complete. Ingestion, scoring, drafts and PDFs carry on. Every panel shows the red "Outbound
paused globally" banner.

Check: Jobs and queue shows "Paused" and lists the switch that holds it.

Resume: **Resume outbound** in Jobs and queue clears the admin switch and removes a lock written by
a restore. Delete a hand-made `outbound.lock` yourself, and set `OUTBOUND_PAUSED=0` and restart for
the environment switch.

## Restore the database from a backup

Use it after data loss or corruption, never to undo a single mistake (a restore also brings back
everything else as it was).

1. Pause outbound (above), then stop the web app and the worker.
2. `npm run db:restore -- --latest` shows the newest backup, its mode and its time. Choose another
   with `--manifest <file.db.json>` from the backups folder.
3. `npm run db:restore -- --latest --yes`. It writes `outbound.lock`, replaces the data in one
   transaction, marks every send that was queued or in flight at backup time `AMBIGUOUS`
   (`RESTORED_IN_FLIGHT`), replays the suppression journal entries newer than the backup and sets
   the admin pause. It prints the counts of each.
4. Start the web app and the worker. Outbound stays paused.
5. Resolve the "Delivery unknown" sends (next runbook). Then **Resume outbound**.

If it refuses: `WORKER_RUNNING` (stop the worker), the other mode, a checksum mismatch, a corrupt
file, or migrations this database lacks (update the app and run `npm run db:deploy` first). A
refused or failed restore leaves the database unchanged. Quotation PDFs are not in the database
backup; copy the storage folder back from the same point in time if you have it.

## Resolve "Delivery unknown" sends

An `AMBIGUOUS` attempt may or may not have reached the customer: a timeout after the request was
written, a worker killed mid-send, or a restore. It is never sent again automatically, and a
matching delivery status from the provider settles it on its own.

1. Jobs and queue, the **Delivery unknown** tile, then each job.
2. Look for evidence: the provider's own records, or the customer's reply in the Inbox.
3. Choose one, with a reason:
   - **Mark delivered** when you have evidence it arrived. The message, the lead stage and the
     quotation move exactly as if the send had settled.
   - **Verified not delivered** when you have evidence it did not; nothing is sent.
   - **Not delivered: resend** when it did not arrive and should go out: type `RESEND`. A new
     attempt is created and runs every check again, so a contact who has since said Stop is
     skipped.

Check: the **Delivery unknown** count on Jobs and queue drops to zero.

## Administrator locked out or password lost

Five failed sign-ins in a row lock an account for 15 minutes. Waiting is enough for a lock. For a
lost password, on the server, with the LIVE `.env`:

```bash
npm run admin:bootstrap -- --recover --email admin@yourcompany.in
```

It prints a single-use reset link valid for one hour (`/reset/<token>`). Opening it sets a new
password, lifts the lock and signs the account out everywhere; it signs nobody in. The link is
printed once and never logged: open it yourself or hand it over in person.

If no active administrator remains at all, `npm run admin:bootstrap -- --email <address>` (without
`--recover`) issues a new first-administrator invite.

## Suppression pepper lost

`SUPPRESSION_PEPPER` keys every suppression and consent record. Without the original value no
stored opt-out matches a phone number or email address any more, so people who said Stop could be
contacted again. LIVE refuses to start without a pepper, but it starts with a wrong one.

1. Pause outbound at once (first runbook) and keep it paused.
2. Recover the original value: the secrets backup, the server's environment variables, older copies
   of `.env`. Put it back exactly, restart both processes.
3. Check: a contact you know said Stop is refused with `SUPPRESSED` when you try to send.
4. If the value cannot be recovered, do not resume outbound. The journal holds the same keyed
   hashes and cannot help. Suppression rows keep the plain contact only where it was known and was
   not erased; they are the only material from which keys could be recomputed, and no tool for that
   exists in this release. Treat it as a data incident and involve engineering before any send.

## Worker stopped

Symptoms: Platform admin says "Worker not running", jobs pile up as due, nothing new is drafted or
rendered.

1. Start it: `npm run start:worker` from the project folder (or let the service manager restart it).
2. If it exits at once, its last line starts with `worker failed to start:`. Pending migrations:
   stop the web app, run `npm run db:deploy`, start both. Configuration problems are listed in
   `/docs/troubleshooting`.
3. Check: the worker card on Platform admin shows a heartbeat within the last 10 seconds, and the
   due count falls.

Jobs that were running when it stopped are claimed again after their 60-second lease, except sends
that may have reached the provider, which become "Delivery unknown" (previous runbook).
