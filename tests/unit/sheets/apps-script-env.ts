/**
 * A stand-in for the Apps Script runtime (T34), so the generated script can run in node's `vm`:
 * a Spreadsheet with one tab whose cells record every write, Script Properties, Utilities (HMAC
 * with Google's signed-byte output, UUIDs, sleep), UrlFetchApp with scripted answers, LockService,
 * ScriptApp triggers and the menu/prompt UI. Only what the generated script calls is modelled; an
 * unexpected call throws, so the test notices a script that reaches for something else.
 *
 * Shapes follow the Apps Script reference as far as it could be checked (search snippets only;
 * docs/integrations.md marks them UNVERIFIED). This is not the Google runtime: the test proves the
 * script's own logic (event ids, signing, retries, the queue) and that the server accepts what it
 * signs, not Google's trigger behaviour.
 */
import { createHmac } from 'node:crypto';
import vm from 'node:vm';

export type Cell = string | number | boolean | Date;

export type CellWrite = { row: number; col: number; value: unknown };

export class FakeSheet {
  /** rows[0] is row 1 (the header). */
  readonly rows: Cell[][];
  readonly writes: CellWrite[] = [];
  readonly hidden: number[] = [];
  readonly protections: Array<{ row: number; col: number; numRows: number; numCols: number; description: string | null; warningOnly: boolean }> = [];
  constructor(
    readonly name: string,
    rows: Cell[][],
    readonly sheetId = 101,
  ) {
    this.rows = rows.map((r) => [...r]);
  }
  cell(row: number, col: number): Cell {
    return this.rows[row - 1]?.[col - 1] ?? '';
  }
  set(row: number, col: number, value: Cell): void {
    while (this.rows.length < row) this.rows.push([]);
    const r = this.rows[row - 1]!;
    while (r.length < col) r.push('');
    r[col - 1] = value;
    this.writes.push({ row, col, value });
  }
  getName() {
    return this.name;
  }
  getSheetId() {
    return this.sheetId;
  }
  getLastRow() {
    for (let i = this.rows.length; i > 0; i -= 1) if (this.rows[i - 1]!.some((c) => c !== '')) return i;
    return 0;
  }
  getLastColumn() {
    let max = 0;
    for (const r of this.rows) for (let c = r.length; c > max; c -= 1) if (r[c - 1] !== '') max = c;
    return max;
  }
  getMaxRows() {
    return Math.max(1000, this.rows.length);
  }
  hideColumns(col: number) {
    this.hidden.push(col);
  }
  getRange(row: number, col: number, numRows = 1, numCols = 1) {
    if (!Number.isInteger(row) || row < 1 || !Number.isInteger(col) || col < 1 || numRows < 1 || numCols < 1) throw new Error(`bad range ${row},${col},${numRows},${numCols}`);
    return {
      getRow: () => row,
      getSheet: () => this,
      getValues: () => Array.from({ length: numRows }, (_, i) => Array.from({ length: numCols }, (_, j) => this.cell(row + i, col + j))),
      getValue: () => this.cell(row, col),
      setValue: (v: Cell) => {
        this.set(row, col, v);
      },
      setValues: (values: Cell[][]) => {
        if (values.length !== numRows || values.some((r) => r.length !== numCols)) throw new Error('setValues dimensions differ from the range');
        values.forEach((r, i) => r.forEach((v, j) => this.set(row + i, col + j, v)));
      },
      protect: () => {
        const p = { row, col, numRows, numCols, description: null as string | null, warningOnly: false };
        this.protections.push(p);
        const api = {
          setDescription: (d: string) => {
            p.description = d;
            return api;
          },
          setWarningOnly: (w: boolean) => {
            p.warningOnly = w;
            return api;
          },
        };
        return api;
      },
    };
  }
}

export type FetchAnswer = { code: number; body?: unknown; headers?: Record<string, string> } | { throw: string };
export type FetchCall = { url: string; params: { method: string; contentType: string; payload: string; headers: Record<string, string>; muteHttpExceptions: boolean; followRedirects: boolean } };

export type Trigger = { handler: string; kind: string; detail: unknown };

export class AppsScriptEnv {
  readonly properties = new Map<string, string>();
  readonly fetches: FetchCall[] = [];
  readonly answers: FetchAnswer[] = [];
  readonly sleeps: number[] = [];
  readonly logs: string[] = [];
  readonly alerts: string[] = [];
  readonly menus: Array<{ name: string; items: Array<[string, string]> }> = [];
  triggers: Trigger[] = [];
  promptAnswer: { button: 'OK' | 'CANCEL'; text: string } = { button: 'CANCEL', text: '' };
  private uuid = 0;
  private context: vm.Context | null = null;

  constructor(
    readonly spreadsheetId: string,
    readonly sheet: FakeSheet,
    readonly nowMs: number,
  ) {}

  /** Answers the next UrlFetchApp calls in order (an unscripted call answers 200). */
  answer(...answers: FetchAnswer[]): this {
    this.answers.push(...answers);
    return this;
  }

  load(source: string): this {
    const FIXED = this.nowMs;
    class FixedDate extends Date {
      constructor(...args: [] | [string | number | Date]) {
        if (args.length === 0) super(FIXED);
        else super(args[0]);
      }
      static override now() {
        return FIXED;
      }
    }
    const spreadsheet = {
      getSheetByName: (name: string) => (name === this.sheet.name ? this.sheet : null),
      getSheets: () => [this.sheet],
      getId: () => this.spreadsheetId,
    };
    const ui = {
      Button: { OK: 'OK', CANCEL: 'CANCEL' },
      ButtonSet: { OK_CANCEL: 'OK_CANCEL' },
      prompt: () => ({ getSelectedButton: () => this.promptAnswer.button, getResponseText: () => this.promptAnswer.text }),
      alert: (text: string) => {
        this.alerts.push(String(text));
      },
      createMenu: (name: string) => {
        const menu = { name, items: [] as Array<[string, string]> };
        const api = {
          addItem: (label: string, fn: string) => {
            menu.items.push([label, fn]);
            return api;
          },
          addToUi: () => {
            this.menus.push(menu);
          },
        };
        return api;
      },
    };
    const props = {
      getProperty: (k: string) => this.properties.get(k) ?? null,
      setProperty: (k: string, v: string) => {
        if (typeof v !== 'string') throw new Error('Script Properties hold strings');
        if (Buffer.byteLength(v, 'utf8') > 9 * 1024) throw new Error('Script Properties value over 9 KB');
        this.properties.set(k, v);
        return props;
      },
      deleteProperty: (k: string) => {
        this.properties.delete(k);
        return props;
      },
    };
    const builder = (handler: string) => ({
      forSpreadsheet: (key: string) => ({
        onFormSubmit: () => ({
          create: () => {
            this.triggers.push({ handler, kind: 'onFormSubmit', detail: key });
          },
        }),
      }),
      timeBased: () => ({
        everyMinutes: (n: number) => ({
          create: () => {
            this.triggers.push({ handler, kind: 'everyMinutes', detail: n });
          },
        }),
      }),
    });
    const sandbox = {
      Date: FixedDate,
      console: { log: (...a: unknown[]) => this.logs.push(a.map(String).join(' ')), warn: (...a: unknown[]) => this.logs.push(a.map(String).join(' ')), error: (...a: unknown[]) => this.logs.push(a.map(String).join(' ')) },
      Logger: { log: (...a: unknown[]) => this.logs.push(a.map(String).join(' ')) },
      SpreadsheetApp: {
        openById: (id: string) => {
          if (id !== this.spreadsheetId) throw new Error(`no spreadsheet ${id}`);
          return spreadsheet;
        },
        getActive: () => spreadsheet,
        getUi: () => ui,
      },
      PropertiesService: { getScriptProperties: () => props },
      LockService: { getScriptLock: () => ({ waitLock: () => undefined, tryLock: () => true, releaseLock: () => undefined }) },
      ScriptApp: {
        newTrigger: builder,
        getProjectTriggers: () => this.triggers.map((t) => ({ getHandlerFunction: () => t.handler, __t: t })),
        deleteTrigger: (t: { __t: Trigger }) => {
          this.triggers = this.triggers.filter((x) => x !== t.__t);
        },
      },
      Utilities: {
        MacAlgorithm: { HMAC_SHA_256: 'HMAC_SHA_256' },
        Charset: { UTF_8: 'UTF_8' },
        computeHmacSignature: (alg: string, value: string, key: string, charset: string) => {
          if (alg !== 'HMAC_SHA_256' || charset !== 'UTF_8') throw new Error(`unexpected HMAC call ${alg} ${charset}`);
          // Apps Script returns Byte[]: Java bytes, signed (-128..127).
          return Array.from(new Int8Array(createHmac('sha256', Buffer.from(key, 'utf8')).update(Buffer.from(value, 'utf8')).digest()));
        },
        getUuid: () => {
          this.uuid += 1;
          return `00000000-0000-4000-8000-${String(this.uuid).padStart(12, '0')}`;
        },
        sleep: (ms: number) => {
          this.sleeps.push(ms);
        },
      },
      UrlFetchApp: {
        fetch: (url: string, params: FetchCall['params']) => {
          this.fetches.push({ url, params: JSON.parse(JSON.stringify(params)) as FetchCall['params'] });
          const answer = this.answers.shift() ?? { code: 200, body: { outcome: 'ACCEPTED' } };
          if ('throw' in answer) throw new Error(answer.throw);
          return {
            getResponseCode: () => answer.code,
            getContentText: () => JSON.stringify(answer.body ?? {}),
            getHeaders: () => answer.headers ?? {},
          };
        },
      },
    };
    this.context = vm.createContext(sandbox);
    vm.runInContext(source, this.context, { filename: 'Code.gs' });
    return this;
  }

  /** Calls a top-level function of the loaded script. */
  call(name: string, ...args: unknown[]): unknown {
    if (!this.context) throw new Error('load the script first');
    const fn = (this.context as Record<string, unknown>)[name];
    if (typeof fn !== 'function') throw new Error(`the script has no function ${name}`);
    return (fn as (...a: unknown[]) => unknown)(...args);
  }

  /** A top-level variable of the loaded script (its config object). */
  global<T>(name: string): T {
    if (!this.context) throw new Error('load the script first');
    return vm.runInContext(name, this.context) as T;
  }

  /** The event object of an installable form-submit trigger for a row. */
  formSubmitEvent(row: number) {
    return { range: this.sheet.getRange(row, 1, 1, Math.max(1, this.sheet.getLastColumn())) };
  }

  bodies(): Array<Record<string, unknown>> {
    return this.fetches.map((f) => JSON.parse(f.params.payload) as Record<string, unknown>);
  }
}
