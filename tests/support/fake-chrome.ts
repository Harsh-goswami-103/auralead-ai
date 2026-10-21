/**
 * A fake of the `chrome.*` APIs the extension bridge uses (plan §3 tests/support "fake chrome.*"):
 * `storage.local` (get, set, remove, clear, `onChanged`), `alarms` (create, get, getAll, clear,
 * `onAlarm`), `runtime` (id, getURL, onStartup, onInstalled, onMessage) and `permissions`.
 *
 * It behaves like Chrome where the bridge depends on it:
 * - values are stored as structured clones, so a reader never shares objects with a writer;
 * - `storage.onChanged` fires after the write resolves, with `oldValue` / `newValue` per key and
 *   the area name `local`, for writes by anyone (the vendor code or the bridge);
 * - alarms belong to the browser, not to the service worker: they survive a service-worker
 *   termination, while every event listener is dropped with it (`terminateServiceWorker`);
 * - time is the harness clock; alarms fire only when the test calls `fireDueAlarms()`.
 *
 * Every write through the API object is recorded with its keys (`writes`), so a test can prove
 * the bridge never wrote the vendor's key. The vendor's own writes go through `vendorSet`, which
 * is not part of the API object handed to the bridge.
 */
export type StorageChange = { oldValue?: unknown; newValue?: unknown };
export type Alarm = { name: string; scheduledTime: number; periodInMinutes?: number };

type AnyFn = (...args: never[]) => unknown;

export class FakeEvent<F extends AnyFn> {
  private listeners: F[] = [];
  addListener(fn: F): void {
    this.listeners.push(fn);
  }
  removeListener(fn: F): void {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
  hasListener(fn: F): boolean {
    return this.listeners.includes(fn);
  }
  hasListeners(): boolean {
    return this.listeners.length > 0;
  }
  get size(): number {
    return this.listeners.length;
  }
  dispatch(...args: Parameters<F>): void {
    for (const listener of [...this.listeners]) (listener as (...a: Parameters<F>) => unknown)(...args);
  }
  /** The service worker that registered these listeners is gone. */
  reset(): void {
    this.listeners = [];
  }
}

export type StorageWrite = { op: 'set' | 'remove' | 'clear'; keys: string[]; by: 'api' | 'vendor' | 'options' };

type ChangedListener = (changes: Record<string, StorageChange>, areaName: string) => void;

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

export class FakeStorageArea {
  private readonly data = new Map<string, unknown>();
  readonly writes: StorageWrite[] = [];

  constructor(
    private readonly onChanged: FakeEvent<ChangedListener>,
    private readonly areaName: string,
  ) {}

  private notify(changes: Record<string, StorageChange>): void {
    if (Object.keys(changes).length === 0) return;
    // Chrome delivers onChanged asynchronously, after the write's promise settles.
    setTimeout(() => this.onChanged.dispatch(changes, this.areaName), 0);
  }

  private apply(items: Record<string, unknown>, by: StorageWrite['by']): void {
    const changes: Record<string, StorageChange> = {};
    for (const [key, value] of Object.entries(items)) {
      const oldValue = this.data.get(key);
      const newValue = clone(value);
      this.data.set(key, newValue);
      changes[key] = { ...(oldValue === undefined ? {} : { oldValue: clone(oldValue) }), newValue: clone(newValue) };
    }
    this.writes.push({ op: 'set', keys: Object.keys(items), by });
    this.notify(changes);
  }

  async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    if (keys === undefined || keys === null) {
      for (const [k, v] of this.data) out[k] = clone(v);
      return out;
    }
    if (typeof keys === 'string') keys = [keys];
    if (Array.isArray(keys)) {
      for (const k of keys) if (this.data.has(k)) out[k] = clone(this.data.get(k));
      return out;
    }
    for (const [k, fallback] of Object.entries(keys)) out[k] = this.data.has(k) ? clone(this.data.get(k)) : fallback;
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.apply(items, 'api');
  }

  async remove(keys: string | string[]): Promise<void> {
    const list = typeof keys === 'string' ? [keys] : keys;
    const changes: Record<string, StorageChange> = {};
    for (const k of list) {
      if (!this.data.has(k)) continue;
      changes[k] = { oldValue: clone(this.data.get(k)) };
      this.data.delete(k);
    }
    this.writes.push({ op: 'remove', keys: list, by: 'api' });
    this.notify(changes);
  }

  async clear(): Promise<void> {
    const changes: Record<string, StorageChange> = {};
    for (const [k, v] of this.data) changes[k] = { oldValue: clone(v) };
    this.data.clear();
    this.writes.push({ op: 'clear', keys: Object.keys(changes), by: 'api' });
    this.notify(changes);
  }

  /**
   * A write by another page of the extension: the vendor's own code (`vendor`) or the bridge's
   * options page (`options`). Not part of the API object the bridge's service worker receives.
   */
  vendorSet(items: Record<string, unknown>, by: 'vendor' | 'options' = 'vendor'): void {
    this.apply(items, by);
  }

  /** Synchronous read for assertions. */
  peek<T = unknown>(key: string): T | undefined {
    return clone(this.data.get(key)) as T | undefined;
  }
}

export type FakeClock = { now(): number; advance(ms: number): void; set(ms: number): void };

export function fakeClock(start: number): FakeClock {
  let ms = start;
  return {
    now: () => ms,
    advance: (delta) => {
      ms += delta;
    },
    set: (to) => {
      ms = to;
    },
  };
}

export class FakeAlarms {
  private readonly alarms = new Map<string, Alarm>();
  readonly onAlarm = new FakeEvent<(alarm: Alarm) => void>();
  readonly created: Alarm[] = [];

  constructor(private readonly clock: FakeClock) {}

  async create(name: string, info: { when?: number; delayInMinutes?: number; periodInMinutes?: number }): Promise<void> {
    const now = this.clock.now();
    // Chrome raises sub-30-second alarms to 30 seconds.
    const when = info.when ?? now + Math.max(0.5, info.delayInMinutes ?? info.periodInMinutes ?? 0.5) * 60_000;
    const alarm: Alarm = { name, scheduledTime: Math.max(when, now + 30_000), ...(info.periodInMinutes ? { periodInMinutes: info.periodInMinutes } : {}) };
    this.alarms.set(name, alarm);
    this.created.push({ ...alarm });
  }

  async get(name: string): Promise<Alarm | undefined> {
    const alarm = this.alarms.get(name);
    return alarm ? { ...alarm } : undefined;
  }

  async getAll(): Promise<Alarm[]> {
    return [...this.alarms.values()].map((a) => ({ ...a }));
  }

  async clear(name: string): Promise<boolean> {
    return this.alarms.delete(name);
  }

  async clearAll(): Promise<boolean> {
    const had = this.alarms.size > 0;
    this.alarms.clear();
    return had;
  }

  peek(name: string): Alarm | undefined {
    return this.alarms.get(name);
  }

  /** Fires every alarm whose time has come (periodic ones are rescheduled). Returns them. */
  fireDue(): Alarm[] {
    const now = this.clock.now();
    const due = [...this.alarms.values()].filter((a) => a.scheduledTime <= now);
    for (const alarm of due) {
      if (alarm.periodInMinutes) this.alarms.set(alarm.name, { ...alarm, scheduledTime: now + alarm.periodInMinutes * 60_000 });
      else this.alarms.delete(alarm.name);
      this.onAlarm.dispatch({ ...alarm });
    }
    return due;
  }
}

export type FakeChrome = {
  storage: { local: FakeStorageArea; onChanged: FakeEvent<ChangedListener> };
  alarms: FakeAlarms;
  runtime: {
    id: string;
    getURL: (path: string) => string;
    onStartup: FakeEvent<() => void>;
    onInstalled: FakeEvent<(details: { reason: string }) => void>;
    onMessage: FakeEvent<(message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void>;
    lastError?: undefined;
  };
  permissions: { contains: (p: { origins?: string[] }) => Promise<boolean>; request: (p: { origins?: string[] }) => Promise<boolean>; requested: string[][] };
  /** Drops every listener, as Chrome does when it terminates an idle MV3 service worker. */
  terminateServiceWorker: () => void;
};

export function createFakeChrome(options: { clock: FakeClock; extensionId: string }): FakeChrome {
  const onChanged = new FakeEvent<ChangedListener>();
  const local = new FakeStorageArea(onChanged, 'local');
  const alarms = new FakeAlarms(options.clock);
  const runtime: FakeChrome['runtime'] = {
    id: options.extensionId,
    getURL: (p: string) => `chrome-extension://${options.extensionId}/${p.replace(/^\/+/, '')}`,
    onStartup: new FakeEvent(),
    onInstalled: new FakeEvent(),
    onMessage: new FakeEvent(),
  };
  const requested: string[][] = [];
  const permissions: FakeChrome['permissions'] = {
    contains: async () => true,
    request: async (p) => {
      requested.push(p.origins ?? []);
      return true;
    },
    requested,
  };
  return {
    storage: { local, onChanged },
    alarms,
    runtime,
    permissions,
    terminateServiceWorker: () => {
      onChanged.reset();
      alarms.onAlarm.reset();
      runtime.onStartup.reset();
      runtime.onInstalled.reset();
      runtime.onMessage.reset();
    },
  };
}

/** Lets pending timers and microtasks run (onChanged deliveries are setTimeout 0). */
export async function flushEvents(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
