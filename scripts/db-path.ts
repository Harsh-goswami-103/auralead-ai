/**
 * `npm run db:path`: prints the SQLite file the current config resolves to (the same value the
 * app, worker, seed and Prisma config use). `--url` prints the file: URL, `--json` prints every
 * resolved path. OneDrive warnings go to stderr.
 */
import { ConfigError, getConfig } from '../src/lib/config';

function main(argv: string[]): number {
  try {
    const config = getConfig();
    const { paths } = config;
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ mode: config.mode, ...paths }, null, 2));
    } else if (argv.includes('--url')) {
      console.log(paths.databaseUrl);
    } else {
      console.log(paths.dbFile);
    }
    for (const warning of paths.warnings) console.error(`WARNING: ${warning}`);
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

process.exitCode = main(process.argv.slice(2));
