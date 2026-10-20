// Child process for tests/support/sqlite-holder.ts: owns one independent SQLite connection (node:sqlite)
// and runs the SQL it is sent, one JSON command per stdin line. Plain JS on purpose: spawned with
// process.execPath and no loader.
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';

const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA busy_timeout = 0');

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, op, sql } = JSON.parse(line);
  try {
    if (op === 'exec') db.exec(sql);
    else if (op === 'release' && db.isTransaction) db.exec('ROLLBACK');
    else if (op === 'close') {
      if (db.isTransaction) db.exec('ROLLBACK');
      db.close();
      process.stdout.write(`${JSON.stringify({ id, ok: true })}\n`);
      process.exit(0);
    }
    process.stdout.write(`${JSON.stringify({ id, ok: true })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id, ok: false, error: String(error && error.message ? error.message : error) })}\n`);
  }
});
