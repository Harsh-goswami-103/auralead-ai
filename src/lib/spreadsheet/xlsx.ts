/**
 * Minimal XLSX (Office Open XML SpreadsheetML) writer and reader on fflate (ADR-117). Pure:
 * bytes in, rows out; no I/O, no clock (the zip timestamp is fixed, so output is deterministic).
 *
 * Writer: one worksheet, every value an inline string or a number, the header row bold. Text is
 * never written as a formula, so a cell like `=HYPERLINK(...)` stays text in every spreadsheet app.
 *
 * Reader: the first sheet in workbook order, shared strings (rich text runs joined, phonetic runs
 * dropped), inline strings, `str`, booleans and numbers, sparse cells placed by their reference.
 * Every value comes back as a string; formatting, formulas and dates (Excel serials) are not
 * interpreted. Limits guard against zip bombs and huge sheets.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type UnzipFileInfo } from 'fflate';
import { SpreadsheetError, SPREADSHEET_LIMITS, type CellValue, type Table } from './types';

const FIXED_MTIME = new Date('2026-01-01T00:00:00Z');
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function escapeXml(value: string): string {
  // XML 1.0 forbids most control characters even when escaped; drop them.
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Excel refuses `: \ / ? * [ ]` and names over 31 characters. */
export function cleanSheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31).trim();
  return cleaned === '' ? 'Sheet1' : cleaned;
}

function columnLetters(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function cellXml(ref: string, value: CellValue, style: number): string {
  if (value === null || value === undefined || value === '') return '';
  const s = style > 0 ? ` s="${style}"` : '';
  if (typeof value === 'number') return Number.isFinite(value) ? `<c r="${ref}"${s}><v>${value}</v></c>` : '';
  if (typeof value === 'boolean') return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  const space = /^\s|\s$/.test(value) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}"${s} t="inlineStr"><is><t${space}>${escapeXml(value)}</t></is></c>`;
}

export type XlsxInput = { sheetName: string; header: readonly string[]; rows: readonly (readonly CellValue[])[] };

export function writeXlsx(input: XlsxInput): Uint8Array {
  const sheetName = cleanSheetName(input.sheetName);
  const all: (readonly CellValue[])[] = [input.header, ...input.rows];
  const width = Math.max(1, ...all.map((r) => r.length));
  const widths = Array.from({ length: width }, (_, c) =>
    Math.min(60, Math.max(8, ...all.map((r) => (r[c] === null || r[c] === undefined ? 0 : String(r[c]).length + 2)))),
  );
  const rowsXml = all
    .map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cellXml(`${columnLetters(c)}${r + 1}`, v, r === 0 ? 1 : 0)).join('')}</row>`)
    .join('');
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="${MAIN_NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${rowsXml}</sheetData></worksheet>`;

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`,
    ),
    'xl/styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${MAIN_NS}">` +
        `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
        `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
        `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
        `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
        `</styleSheet>`,
    ),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  };
  return zipSync(files, { level: 6, mtime: FIXED_MTIME });
}

// ---- reader ----------------------------------------------------------------------------------

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

type XmlTag = { name: string; close: boolean; self: boolean; raw: string; text: string };

/** Most tags read from one part: far above any workbook within SPREADSHEET_LIMITS, and a cap on crafted ones. */
const MAX_TAGS_PER_PART = 3_000_000;
const MAX_SHARED_STRINGS = 1_000_000;

/**
 * A single forward pass over the tags of an XML part (indexOf only, no backtracking regex), so the
 * cost is linear in the part's size whatever closing tags are missing. `text` is what precedes the
 * tag. Comments, processing instructions and declarations are skipped.
 */
function* xmlTags(xml: string): Generator<XmlTag> {
  let pos = 0;
  let count = 0;
  for (;;) {
    const lt = xml.indexOf('<', pos);
    if (lt === -1) return;
    const gt = xml.indexOf('>', lt);
    if (gt === -1) return;
    const text = xml.slice(pos, lt);
    pos = gt + 1;
    const first = xml.charCodeAt(lt + 1);
    if (first === 33 /* ! */ || first === 63 /* ? */) continue;
    count += 1;
    if (count > MAX_TAGS_PER_PART) throw new SpreadsheetError('TOO_LARGE', 'This workbook is too large to import.');
    const close = first === 47; /* / */
    const nameStart = lt + (close ? 2 : 1);
    let end = nameStart;
    while (end < gt) {
      const c = xml.charCodeAt(end);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 47) break;
      end += 1;
    }
    yield { name: xml.slice(nameStart, end), close, self: !close && xml.charCodeAt(gt - 1) === 47, raw: xml.slice(lt, gt + 1), text };
  }
}

/** The text of each string item (`<si>`): joined `<t>` runs decoded, phonetic (`rPh`) runs dropped. */
function sharedStringItems(xml: string): string[] {
  const items: string[] = [];
  let current: string | null = null;
  let phonetic = false;
  const finish = () => {
    if (current !== null) items.push(current);
    current = null;
    phonetic = false;
  };
  for (const tag of xmlTags(xml)) {
    if (tag.name === 'si') {
      finish();
      if (items.length >= MAX_SHARED_STRINGS) throw new SpreadsheetError('TOO_LARGE', 'This workbook is too large to import.');
      if (tag.close) continue;
      if (tag.self) items.push('');
      else current = '';
    } else if (current === null) {
      continue;
    } else if (tag.name === 'rPh') {
      phonetic = !tag.close && !tag.self;
    } else if (tag.name === 't' && tag.close && !phonetic) {
      current += decodeEntities(tag.text);
    }
  }
  finish();
  return items;
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function resolveTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = `xl/${target}`.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.') out.push(p);
  }
  return out.join('/');
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export function readXlsx(bytes: Uint8Array): Table {
  if (!isZip(bytes)) throw new SpreadsheetError('NOT_A_WORKBOOK', 'This file is not an .xlsx workbook.');
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (file: UnzipFileInfo) => {
        if (!file.name.endsWith('.xml') && !file.name.endsWith('.rels')) return false;
        total += file.originalSize;
        if (file.originalSize > SPREADSHEET_LIMITS.maxUncompressedBytes || total > SPREADSHEET_LIMITS.maxUncompressedBytes) {
          throw new SpreadsheetError('TOO_LARGE', 'This workbook is too large to import.');
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof SpreadsheetError) throw error;
    throw new SpreadsheetError('NOT_A_WORKBOOK', 'This file is not a readable .xlsx workbook.');
  }
  for (const part of Object.values(files)) {
    if (part.length > SPREADSHEET_LIMITS.maxUncompressedBytes) throw new SpreadsheetError('TOO_LARGE', 'This workbook is too large to import.');
  }

  const workbook = files['xl/workbook.xml'];
  if (!workbook) throw new SpreadsheetError('NOT_A_WORKBOOK', 'This file is not an .xlsx workbook.');
  const workbookXml = strFromU8(workbook);
  const firstSheet = /<sheet\b[^>]*>/.exec(workbookXml)?.[0];
  if (!firstSheet) throw new SpreadsheetError('NOT_A_WORKBOOK', 'The workbook has no sheets.');
  const sheetName = decodeEntities(attr(firstSheet, 'name') ?? 'Sheet1');
  const relId = /\sr:id="([^"]*)"/.exec(firstSheet)?.[1];

  const relsPart = files['xl/_rels/workbook.xml.rels'];
  const relsXml = relsPart ? strFromU8(relsPart) : '';
  let sheetPath = 'xl/worksheets/sheet1.xml';
  let sharedPath = 'xl/sharedStrings.xml';
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    const type = attr(m[0], 'Type') ?? '';
    if (!target) continue;
    if (id === relId) sheetPath = resolveTarget(target);
    if (type.endsWith('/sharedStrings')) sharedPath = resolveTarget(target);
  }
  const sheetBytes = files[sheetPath];
  if (!sheetBytes) throw new SpreadsheetError('NOT_A_WORKBOOK', 'The first sheet of the workbook is missing.');

  const sharedPart = files[sharedPath];
  const shared = sharedPart ? sharedStringItems(strFromU8(sharedPart)) : [];

  const sparse = new Map<number, string[]>();
  let lastRow = 0;
  let maxRow = 0;
  let row: string[] | null = null;
  let rowNumber = 0;
  let rowHasValue = false;
  let nextCol = 0;
  let cell: { col: number; type: string | undefined; raw: string | undefined; inline: string } | null = null;
  let inInline = false;
  let phonetic = false;
  const finishCell = () => {
    if (cell !== null && row !== null && cell.col >= 0 && cell.col < SPREADSHEET_LIMITS.maxColumns) {
      const { col, type, raw } = cell;
      let value = '';
      if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = cell.inline;
      else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
      else if (raw !== undefined) value = decodeEntities(raw);
      while (row.length < col) row.push('');
      row[col] = value;
      if (value.trim() !== '') rowHasValue = true;
    }
    cell = null;
    inInline = false;
    phonetic = false;
  };
  const finishRow = () => {
    finishCell();
    // A row with no value (Excel writes styled blank rows far down a sheet) is neither counted nor kept.
    if (row !== null && rowHasValue) {
      if (rowNumber > SPREADSHEET_LIMITS.maxRows) throw new SpreadsheetError('TOO_MANY_ROWS', `A sheet can hold at most ${SPREADSHEET_LIMITS.maxRows} rows.`);
      sparse.set(rowNumber, row);
      maxRow = Math.max(maxRow, rowNumber);
    }
    row = null;
    rowHasValue = false;
  };
  for (const tag of xmlTags(strFromU8(sheetBytes))) {
    if (tag.name === 'row') {
      finishRow();
      if (tag.close) continue;
      const n = Number(attr(tag.raw, 'r') ?? lastRow + 1);
      if (!Number.isInteger(n) || n < 1) continue;
      lastRow = n;
      rowNumber = n;
      nextCol = 0;
      row = tag.self ? null : [];
    } else if (row === null) {
      continue;
    } else if (tag.name === 'c') {
      finishCell();
      if (tag.close) continue;
      const ref = attr(tag.raw, 'r');
      const col = ref ? columnIndex(ref) : nextCol;
      nextCol = col + 1;
      cell = { col, type: attr(tag.raw, 't'), raw: undefined, inline: '' };
      if (tag.self) finishCell();
    } else if (cell === null) {
      continue;
    } else if (tag.name === 'v') {
      if (tag.close) cell.raw = tag.text;
    } else if (tag.name === 'is') {
      inInline = !tag.close && !tag.self;
    } else if (tag.name === 'rPh') {
      phonetic = !tag.close && !tag.self;
    } else if (tag.name === 't' && tag.close && inInline && !phonetic) {
      cell.inline += decodeEntities(tag.text);
    }
  }
  finishRow();
  const rows: string[][] = [];
  for (let n = 1; n <= maxRow; n += 1) rows.push(sparse.get(n) ?? []);
  const width = Math.max(0, ...rows.map((r) => r.length));
  return { sheetName, rows: rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')) };
}
