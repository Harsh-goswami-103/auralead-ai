# Deployment

Operating AuraLead AI on one server. The step-by-step LIVE setup (configuration, secrets, HTTPS,
the first administrator, build and start) is the in-app page `/docs/going-live`; incident steps are
in [runbooks.md](runbooks.md). Checked against the code on 2026-10-20.

## Shape of a deployment

- One machine, one mode per process pair: a web process (`npm run start`, `next start`) and a worker
  (`npm run start:worker`, `node dist/worker.js`), both started from the project folder with the
  same `.env`. A second pair with the other mode needs its own `.env` and data folder.
- A reverse proxy in front terminates TLS. Set `TRUSTED_PROXY_HOPS` to the number of proxies so the
  rate limits see the real client IP, and keep the public URL identical to `APP_ORIGIN`: changes are
  refused when the Origin header differs.
- `GET /api/health` answers 200 `{"status":"ok","mode":"live"}` when the web process is configured
  and the database answers, 503 otherwise.

## SQLite limits

Each mode is one SQLite file, opened with WAL, `busy_timeout` 5000 ms and foreign keys on
(`src/server/db/client.ts`).

- **One writer at a time.** The web process and the worker share the file. `withTx` takes the write
  lock at the start of each transaction and retries on a busy error; when it still cannot get the
  lock, the user sees "The system is busy. Try again in a moment." (`DB_BUSY`, 503). Transactions
  are kept short and never wait on the network.
- **One web process.** Rate limits are kept in the web process memory (`src/server/security/rate-limit.ts`);
  several web processes would each count separately.
- **Local disk only.** Never put the data folder in OneDrive or on a network share: syncing corrupts
  the WAL files. The app logs a warning at start when a path is inside OneDrive.
- **Migrations.** `npm run db:deploy` applies them; the worker refuses to start while one is
  pending. Stop both processes before migrating (Windows holds file locks on the database and the
  native modules).

## Storage

Everything lives in the mode folder (`%LOCALAPPDATA%\auralead\<mode>\` on Windows,
`~/.local/share/auralead/<mode>/` elsewhere, or under `AURALEAD_DATA_DIR`); `npm run db:path -- --json`
prints the resolved paths.

| Path | Contents | Override |
|---|---|---|
| `app.db` | The database | `DATABASE_URL` (a `file:` URL) |
| `storage/` | Quotation PDFs at `quotes/<workspaceId>/<quoteVersionId>.pdf`, each checked against its stored sha256 before download | `STORAGE_DIR` |
| `backups/` | Backups and their manifests | `BACKUP_DIR` |
| `journal/` | Suppression journal, `suppressions-YYYYMMDD.jsonl`, appended after each Stop or opt-in clear commits | none |
| `outbound.lock` | Present while outbound is paused by a restore or an operator | none |

## Worker lifecycle

- Start: `npm run start:worker` loads `.env` (real environment variables win), validates the
  configuration, opens the database, compares `prisma/migrations` with the applied migrations, and
  exits with `worker failed to start:` on any problem.
- Run: claims due jobs one at a time, renews the lease of a long job every 20 s, writes a heartbeat
  every 10 s, and reaps jobs whose lease (60 s) ran out. Platform admin shows "Worker not running"
  when the newest heartbeat is older than 30 s.
- Stop: SIGINT, SIGTERM or SIGBREAK (Ctrl+C, Ctrl+Break) stops claiming and waits up to 25 s for the
  job in hand. A hard kill is safe: the job is reclaimed after its lease, and a send that may have
  reached the provider becomes `AMBIGUOUS` instead of being repeated.
- Supervise both processes with the platform's service manager so they start at boot and restart
  when they exit.

## Backups

`npm run db:backup` writes a consistent `VACUUM INTO` copy, safe while both processes run, to
`<backups>/auralead-<mode>-<UTC time>.db`, then `<file>.json` with the format, mode, backup time,
size, sha256 and applied migrations. The manifest is written last, so a manifest means a complete
backup.

- Run it on a schedule with the same `.env` as the app.
- Copy the storage folder alongside if you need the PDFs; they are not in the database.
- The suppression journal is deliberately not in a backup: a restore replays it.
- Keep a copy of the secrets (`SUPPRESSION_PEPPER`, `CREDENTIALS_KEYRING`, `CREDENTIALS_ACTIVE_KID`,
  `SESSION_SECRET`, `SHARE_NONCE_KEY`) somewhere safe and separate from the backups: a restored
  database is only usable with the secrets it was written with.
- Backups are never deleted by the app. They contain personal data, including leads erased after
  the backup was taken.

## Restore

`npm run db:restore -- --latest` (or `--manifest <file.db.json>`) shows what it would restore;
add `--yes` to restore. Stop the web app and the worker first; a fresh worker heartbeat refuses the
restore (`--allow-running-worker` overrides it, only when you are sure the worker is gone).

1. The manifest, the mode and the sha256 are checked before anything changes.
2. `outbound.lock` is written first, so nothing can pass a send preflight from then on.
3. In one transaction on the live file: every application table is replaced by the backup's rows
   (a backup taken before a later additive migration still restores; one with migrations this
   database lacks is refused), every send that was `QUEUED` or `SENDING` at backup time becomes
   `AMBIGUOUS` with reason `RESTORED_IN_FLIGHT` and its job `DEAD`, the suppression journal entries
   newer than the backup are replayed in order, and the admin outbound pause is set.
4. Start the processes. Review the "Delivery unknown" sends in Platform admin, Jobs and queue, then
   press Resume outbound there; it clears the admin pause and removes the lock the restore wrote.

A restore that fails before committing leaves the database unchanged and removes the lock it wrote.

## Moving to PostgreSQL

The app runs on SQLite only. This is what a move to PostgreSQL would involve, from plan section
5.8; none of it is built.

| Area | SQLite today | PostgreSQL |
|---|---|---|
| Schema | `prisma/schema.prisma` with the SQLite provider, one migrations folder | A PostgreSQL schema generated from it with `@db.*` annotations and a new baseline migration; the Prisma PostgreSQL adapter |
| Money | `BigInt` stored as a 64-bit INTEGER | `int8`; no change |
| Enums | Text | Native enums; each new value needs a migration |
| JSON | Text, never filtered on | `jsonb`; the "never filter on JSON" rule keeps behavior the same |
| Times | The adapter's storage format | `timestamptz(3)`; raw SQL binds `Date` parameters only |
| Search | Normalized columns such as `nameNormalized` | The same columns |
| Partial unique indexes | Hand-written SQL in the migrations | The same SQL, re-added to the baseline |
| Job claim | One `UPDATE ... RETURNING` in `src/server/db/raw/claim-job.ts` | The same statement, optionally with `FOR UPDATE SKIP LOCKED` in the subquery |
| Rate limits | In-process | A shared store, needed before running more than one web process |
| Files | Local storage folder | Object storage instead of the local folder |
| Data move | n/a | Copy in foreign-key order and in batches, keep string ids, verify row counts and quotation totals per workspace, with outbound paused globally |
