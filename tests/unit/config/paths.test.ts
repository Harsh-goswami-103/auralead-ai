import { describe, expect, it } from 'vitest';
import { resolvePaths, toSqliteFileUrl } from '@/lib/paths';

const LOCAL = 'C:\\Users\\Asus\\AppData\\Local';
const REPO = 'C:\\Users\\Asus\\OneDrive\\Documents\\projects\\mini project';

function win(env: Record<string, string | undefined>, mode: 'demo' | 'live' = 'demo', cwd = 'C:\\work') {
  return resolvePaths({ mode, env, platform: 'win32', cwd, homedir: 'C:\\Users\\Asus' });
}

describe('resolvePaths (Windows defaults)', () => {
  it('defaults to %LOCALAPPDATA%\\auralead\\<mode>\\app.db', () => {
    const p = win({ LOCALAPPDATA: LOCAL });

    expect(p.dataDir).toBe(`${LOCAL}\\auralead`);
    expect(p.modeDir).toBe(`${LOCAL}\\auralead\\demo`);
    expect(p.dbFile).toBe(`${LOCAL}\\auralead\\demo\\app.db`);
    expect(p.storageDir).toBe(`${LOCAL}\\auralead\\demo\\storage`);
    expect(p.backupDir).toBe(`${LOCAL}\\auralead\\demo\\backups`);
    expect(p.journalDir).toBe(`${LOCAL}\\auralead\\demo\\journal`);
    expect(p.outboundLockFile).toBe(`${LOCAL}\\auralead\\demo\\outbound.lock`);
    expect(p.warnings).toEqual([]);
  });

  it('separates the DB per mode', () => {
    expect(win({ LOCALAPPDATA: LOCAL }, 'live').dbFile).toBe(`${LOCAL}\\auralead\\live\\app.db`);
  });

  it('builds a file: URL with forward slashes', () => {
    const p = win({ LOCALAPPDATA: LOCAL });

    expect(p.databaseUrl).toBe('file:C:/Users/Asus/AppData/Local/auralead/demo/app.db');
    expect(p.databaseUrl).not.toContain('\\');
  });

  it('falls back to <home>\\AppData\\Local when LOCALAPPDATA is unset', () => {
    expect(win({}).dbFile).toBe('C:\\Users\\Asus\\AppData\\Local\\auralead\\demo\\app.db');
  });
});

describe('resolvePaths overrides', () => {
  it('honors AURALEAD_DATA_DIR (mode is still appended)', () => {
    const p = win({ LOCALAPPDATA: LOCAL, AURALEAD_DATA_DIR: 'D:\\aura' });

    expect(p.dbFile).toBe('D:\\aura\\demo\\app.db');
    expect(p.storageDir).toBe('D:\\aura\\demo\\storage');
    expect(p.databaseUrl).toBe('file:D:/aura/demo/app.db');
  });

  it('honors DATABASE_URL, STORAGE_DIR and BACKUP_DIR', () => {
    const p = win({
      LOCALAPPDATA: LOCAL,
      DATABASE_URL: 'file:E:\\db\\custom.db',
      STORAGE_DIR: 'E:\\files',
      BACKUP_DIR: 'E:\\backups',
    });

    expect(p.dbFile).toBe('E:\\db\\custom.db');
    expect(p.databaseUrl).toBe('file:E:/db/custom.db');
    expect(p.storageDir).toBe('E:\\files');
    expect(p.backupDir).toBe('E:\\backups');
    // Not overridden: still under the mode dir.
    expect(p.journalDir).toBe(`${LOCAL}\\auralead\\demo\\journal`);
  });

  it('rejects a non-SQLite DATABASE_URL', () => {
    expect(() => win({ DATABASE_URL: 'postgresql://u:p@h/db' })).toThrow(/file:/);
  });

  it('treats empty override values as unset', () => {
    const p = win({ LOCALAPPDATA: LOCAL, AURALEAD_DATA_DIR: '', DATABASE_URL: '', STORAGE_DIR: '' });

    expect(p.dbFile).toBe(`${LOCAL}\\auralead\\demo\\app.db`);
  });
});

describe('resolvePaths with a space in cwd and OneDrive', () => {
  it('resolves relative overrides against a cwd that contains a space', () => {
    const p = win({ LOCALAPPDATA: LOCAL, AURALEAD_DATA_DIR: '.data' }, 'demo', REPO);

    expect(p.dbFile).toBe(`${REPO}\\.data\\demo\\app.db`);
    expect(p.databaseUrl).toBe('file:C:/Users/Asus/OneDrive/Documents/projects/mini project/.data/demo/app.db');
  });

  it('resolves a relative file: DATABASE_URL against cwd', () => {
    const p = win({ LOCALAPPDATA: LOCAL, DATABASE_URL: 'file:./dev.db' }, 'demo', 'C:\\some dir');

    expect(p.dbFile).toBe('C:\\some dir\\dev.db');
    expect(p.databaseUrl).toBe('file:C:/some dir/dev.db');
  });

  it('emits a OneDrive warning naming each affected path', () => {
    const p = win({ LOCALAPPDATA: LOCAL, AURALEAD_DATA_DIR: '.data', BACKUP_DIR: 'D:\\safe' }, 'demo', REPO);

    expect(p.warnings.length).toBeGreaterThan(0);
    const all = p.warnings.join('\n');
    expect(all).toMatch(/OneDrive/);
    expect(all).toContain(p.dbFile);
    expect(all).toContain(p.storageDir);
    expect(all).not.toContain('D:\\safe');
  });

  it('detects OneDrive case-insensitively', () => {
    const p = win({ LOCALAPPDATA: LOCAL, DATABASE_URL: 'file:C:\\Users\\a\\onedrive - Org\\x.db' });

    expect(p.warnings.some((w) => w.includes('x.db'))).toBe(true);
  });
});

describe('resolvePaths on POSIX', () => {
  it('uses XDG_DATA_HOME, then ~/.local/share', () => {
    const base = { mode: 'demo' as const, platform: 'linux' as const, cwd: '/w', homedir: '/home/u' };

    expect(resolvePaths({ ...base, env: { XDG_DATA_HOME: '/xdg' } }).dbFile).toBe('/xdg/auralead/demo/app.db');
    expect(resolvePaths({ ...base, env: {} }).dbFile).toBe('/home/u/.local/share/auralead/demo/app.db');
    expect(resolvePaths({ ...base, env: {} }).databaseUrl).toBe('file:/home/u/.local/share/auralead/demo/app.db');
  });
});

describe('toSqliteFileUrl', () => {
  it('converts backslashes and keeps spaces unencoded', () => {
    expect(toSqliteFileUrl('C:\\a b\\c.db')).toBe('file:C:/a b/c.db');
  });
});
