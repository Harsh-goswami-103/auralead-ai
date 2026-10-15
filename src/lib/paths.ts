/**
 * Resolves every on-disk location the app uses (ADR-20). The DB, storage, backups and the
 * suppression journal default to a per-mode folder outside the OneDrive-synced repo:
 *   Windows: %LOCALAPPDATA%\auralead\<mode>\
 *   POSIX:   $XDG_DATA_HOME/auralead/<mode>/ (or ~/.local/share/auralead/<mode>/)
 * Overrides: AURALEAD_DATA_DIR (mode is still appended), DATABASE_URL (file: only),
 * STORAGE_DIR, BACKUP_DIR. Relative overrides resolve against cwd.
 *
 * Pure: the caller passes mode, env, platform, cwd and homedir, so this module never reads
 * the mode variable or process state itself.
 */
import path from 'node:path';

export type AppMode = 'demo' | 'live';

export type PathEnv = {
  LOCALAPPDATA?: string | undefined;
  XDG_DATA_HOME?: string | undefined;
  AURALEAD_DATA_DIR?: string | undefined;
  DATABASE_URL?: string | undefined;
  STORAGE_DIR?: string | undefined;
  BACKUP_DIR?: string | undefined;
};

export type ResolvePathsInput = {
  mode: AppMode;
  env: PathEnv;
  platform: NodeJS.Platform;
  cwd: string;
  homedir: string;
};

export type ResolvedPaths = {
  /** Base data dir, without the mode segment. */
  dataDir: string;
  /** `<dataDir>/<mode>` */
  modeDir: string;
  dbFile: string;
  /** Prisma/better-sqlite3 URL: `file:` + absolute path with forward slashes. */
  databaseUrl: string;
  storageDir: string;
  backupDir: string;
  journalDir: string;
  outboundLockFile: string;
  /** Human-readable warnings, e.g. a path inside a OneDrive-synced folder. */
  warnings: string[];
};

const APP_DIR_NAME = 'auralead';

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

/** `C:\a b\c.db` -> `file:C:/a b/c.db`; `/x/y.db` -> `file:/x/y.db`. */
export function toSqliteFileUrl(absPath: string): string {
  return `file:${absPath.replace(/\\/g, '/')}`;
}

export function resolvePaths(input: ResolvePathsInput): ResolvedPaths {
  const { mode, env, platform, cwd, homedir } = input;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const abs = (value: string) => p.resolve(cwd, value);

  const defaultBase =
    platform === 'win32'
      ? (nonEmpty(env.LOCALAPPDATA) ?? p.join(homedir, 'AppData', 'Local'))
      : (nonEmpty(env.XDG_DATA_HOME) ?? p.join(homedir, '.local', 'share'));

  const dataDirOverride = nonEmpty(env.AURALEAD_DATA_DIR);
  const dataDir = dataDirOverride ? abs(dataDirOverride) : p.join(defaultBase, APP_DIR_NAME);
  const modeDir = p.join(dataDir, mode);

  let dbFile = p.join(modeDir, 'app.db');
  const urlOverride = nonEmpty(env.DATABASE_URL);
  if (urlOverride) {
    if (!urlOverride.startsWith('file:')) {
      throw new Error('DATABASE_URL must be a SQLite file: URL (for example file:C:/data/app.db)');
    }
    dbFile = abs(urlOverride.slice('file:'.length));
  }

  const storageOverride = nonEmpty(env.STORAGE_DIR);
  const backupOverride = nonEmpty(env.BACKUP_DIR);
  const storageDir = storageOverride ? abs(storageOverride) : p.join(modeDir, 'storage');
  const backupDir = backupOverride ? abs(backupOverride) : p.join(modeDir, 'backups');
  const journalDir = p.join(modeDir, 'journal');
  const outboundLockFile = p.join(modeDir, 'outbound.lock');

  const warnings: string[] = [];
  const labelled: Array<[string, string]> = [
    ['database', dbFile],
    ['storage', storageDir],
    ['backups', backupDir],
    ['journal', journalDir],
  ];
  for (const [label, value] of labelled) {
    if (/onedrive/i.test(value)) {
      warnings.push(
        `The ${label} path is inside a OneDrive folder (${value}). OneDrive sync corrupts SQLite WAL files and uploads personal data; set AURALEAD_DATA_DIR to a local folder.`,
      );
    }
  }

  return {
    dataDir,
    modeDir,
    dbFile,
    databaseUrl: toSqliteFileUrl(dbFile),
    storageDir,
    backupDir,
    journalDir,
    outboundLockFile,
    warnings,
  };
}
