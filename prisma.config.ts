// Prisma 7 config (ADR-02). Prisma does not load .env itself: the single loader runs first (E12),
// then the datasource URL comes from the same resolver the app and worker use, so the CLI, the
// web process and the worker always agree on the DB file. Paths only, no secrets (ADR-116): the
// postinstall `prisma generate` runs in `npm ci` before `npm run setup` writes the LIVE secrets.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'prisma/config';
import { getDataPaths } from './src/lib/config';

const { databaseUrl, dbFile } = getDataPaths();
// The default data dir (%LOCALAPPDATA%\auralead\<mode>) may not exist on a fresh machine.
mkdirSync(path.dirname(dbFile), { recursive: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // `prisma db seed` (Prisma 7 never seeds automatically); same entry as `npm run db:seed`.
    seed: 'tsx prisma/seed/index.ts',
  },
  datasource: {
    url: databaseUrl,
  },
});
