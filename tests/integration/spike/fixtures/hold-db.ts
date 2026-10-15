/**
 * Child process for teardown.test.ts. Opens the DB through the production client, writes a row
 * (so the -wal and -shm files exist and are held open), starts a grandchild node process, prints
 * `READY {"pid":..,"grandchildPid":..}` and then stays alive until killed.
 */
import { spawn } from 'node:child_process';
import { createPrismaClient } from '@/server/db/client';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

const prisma = createPrismaClient({ url });
await prisma.systemSetting.upsert({
  where: { id: 1 },
  create: { id: 1, outboundPaused: false },
  update: { outboundPauseReason: `held by ${process.pid}` },
});

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
console.log(`READY ${JSON.stringify({ pid: process.pid, grandchildPid: grandchild.pid })}`);

setInterval(() => {
  // keep the event loop (and the open DB handle) alive until the parent kills this process
}, 1000);
