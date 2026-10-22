/**
 * The spreadsheet module (src/lib/spreadsheet, ADR-117): a minimal XLSX writer and reader on
 * fflate, and an RFC 4180 CSV parser, for the lead import and the Excel exports. Pure: bytes in,
 * rows out. The reader must accept what Excel and Google Sheets write (shared strings, rich text
 * runs, sparse cells, booleans, numbers) and refuse what is not a workbook or is too large.
 */
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseCsv, readTable, readXlsx, SpreadsheetError, SPREADSHEET_LIMITS, writeXlsx } from '@/lib/spreadsheet';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A workbook the way Excel writes one: shared strings, explicit cell refs, a second sheet. */
function excelStyleWorkbook(sheetXml: string, sharedStrings: string[], extraSheets: { name: string; xml: string }[] = []): Uint8Array {
  const sheets = [{ name: 'Leads', xml: sheetXml }, ...extraSheets];
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`,
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
        .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 7}"/>`)
        .join('')}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 7}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/data${i + 1}.xml"/>`)
        .join('')}<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ),
    'xl/sharedStrings.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sharedStrings.map((s) => `<si>${s}</si>`).join('')}</sst>`,
    ),
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/data${i + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${s.xml}</sheetData></worksheet>`,
    );
  });
  return zipSync(files);
}

describe('writeXlsx', () => {
  it('writes a workbook that reads back cell for cell, with text, numbers, blanks and Unicode', () => {
    const bytes = writeXlsx({
      sheetName: 'Leads',
      header: ['Name', 'Phone', 'Rating', 'Note'],
      rows: [
        ['Sharma Sweets', '+919812345678', 4.6, 'मिठाई ₹ & <best>'],
        ['Blue Dental', null, 0, ''],
        ['=HYPERLINK("x")', '9812345678', -1.5, undefined],
      ],
    });

    const table = readXlsx(bytes);
    expect(table.sheetName).toBe('Leads');
    expect(table.rows).toEqual([
      ['Name', 'Phone', 'Rating', 'Note'],
      ['Sharma Sweets', '+919812345678', '4.6', 'मिठाई ₹ & <best>'],
      ['Blue Dental', '', '0', ''],
      ['=HYPERLINK("x")', '9812345678', '-1.5', ''],
    ]);
  });

  it('never writes a formula: text that looks like one is an inline string', () => {
    const bytes = writeXlsx({ sheetName: 'S', header: ['A'], rows: [['=1+1'], ['+91 98']] });
    const sheet = text(unzipSync(bytes)['xl/worksheets/sheet1.xml']!);
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).toContain('=1+1');
  });

  it('is deterministic: the same input gives the same bytes', () => {
    const input = { sheetName: 'Leads', header: ['A', 'B'], rows: [['x', 1]] };
    expect(Buffer.from(writeXlsx(input)).equals(Buffer.from(writeXlsx(input)))).toBe(true);
  });

  it('declares the parts Excel needs and a bold header style', () => {
    const files = unzipSync(writeXlsx({ sheetName: 'Leads', header: ['A'], rows: [] }));
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml', 'xl/styles.xml']) {
      expect(files[part], part).toBeDefined();
    }
    expect(text(files['xl/styles.xml']!)).toContain('<b/>');
  });

  it('cleans a sheet name Excel would refuse', () => {
    const table = readXlsx(writeXlsx({ sheetName: 'Leads: Pune/Mumbai [Oct]*?', header: ['A'], rows: [] }));
    expect(table.sheetName).toBe('Leads Pune Mumbai Oct');
  });
});

describe('readXlsx', () => {
  it('reads Excel-style shared strings, sparse cells, rich text runs, booleans and entities', () => {
    const bytes = excelStyleWorkbook(
      [
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>',
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c><c r="C2" t="b"><v>1</v></c></row>',
        '<row r="4"><c r="B4" t="str"><v>a &amp; b</v></c><c r="D4" t="inlineStr"><is><t xml:space="preserve"> padded </t></is></c></row>',
      ].join(''),
      ['<t>Name</t>', '<t>Opted in</t>', '<r><rPr><b/></rPr><t>Rich</t></r><r><t xml:space="preserve"> Text</t></r><rPh sb="0" eb="1"><t>IGNORED</t></rPh>'],
    );

    expect(readXlsx(bytes).rows).toEqual([
      ['Name', '', 'Opted in', ''],
      ['Rich Text', '42', 'TRUE', ''],
      ['', '', '', ''],
      ['', 'a & b', '', ' padded '],
    ]);
  });

  it('reads the first sheet in workbook order, whatever its part name', () => {
    const bytes = excelStyleWorkbook('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', ['<t>first</t>', '<t>second</t>'], [
      { name: 'Other', xml: '<row r="1"><c r="A1" t="s"><v>1</v></c></row>' },
    ]);
    expect(readXlsx(bytes)).toEqual({ sheetName: 'Leads', rows: [['first']] });
  });

  it('decodes numeric character references', () => {
    const bytes = excelStyleWorkbook('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', ['<t>&#8377;&#x20B9; &lt;ok&gt; &quot;q&quot; &apos;</t>']);
    expect(readXlsx(bytes).rows).toEqual([['₹₹ <ok> "q" \'']]);
  });

  it('refuses bytes that are not a workbook', () => {
    expect(() => readXlsx(strToU8('Name,Phone\nA,1'))).toThrowError(SpreadsheetError);
    expect(() => readXlsx(zipSync({ 'hello.txt': strToU8('hi') }))).toThrowError(expect.objectContaining({ code: 'NOT_A_WORKBOOK' }));
  });

  it('refuses a workbook over the row limit', () => {
    const rows = Array.from({ length: SPREADSHEET_LIMITS.maxRows + 1 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
    expect(() => readXlsx(excelStyleWorkbook(rows, []))).toThrowError(expect.objectContaining({ code: 'TOO_MANY_ROWS' }));
  });

  it('refuses a part that inflates past the size limit (zip bomb)', () => {
    const huge = new Uint8Array(SPREADSHEET_LIMITS.maxUncompressedBytes + 1).fill(32);
    const bytes = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'xl/workbook.xml': huge });
    expect(() => readXlsx(bytes)).toThrowError(expect.objectContaining({ code: 'TOO_LARGE' }));
  });
});

describe('parseCsv', () => {
  it('parses RFC 4180: BOM, quotes, doubled quotes, embedded newlines, CRLF and a missing final newline', () => {
    const csv = '﻿Name,Phone,Note\r\n"Sharma, Sweets",+919812345678,"He said ""hi""\nthen left"\r\nBlue,98,\r\nLast,1,x';
    expect(parseCsv(csv)).toEqual([
      ['Name', 'Phone', 'Note'],
      ['Sharma, Sweets', '+919812345678', 'He said "hi"\nthen left'],
      ['Blue', '98', ''],
      ['Last', '1', 'x'],
    ]);
  });

  it('drops fully empty lines and strips the apostrophe our own CSV export adds before formula characters', () => {
    expect(parseCsv("A,B\n\n'+919812345678,'=x\n,\n")).toEqual([
      ['A', 'B'],
      ['+919812345678', '=x'],
    ]);
  });

  it('refuses an unterminated quote', () => {
    expect(() => parseCsv('A\n"open')).toThrowError(expect.objectContaining({ code: 'MALFORMED_CSV' }));
  });
});

describe('readTable', () => {
  it('picks the format from the bytes, not the file name', () => {
    const xlsx = writeXlsx({ sheetName: 'S', header: ['A'], rows: [['1']] });
    expect(readTable(xlsx, 'leads.csv').rows).toEqual([['A'], ['1']]);
    expect(readTable(strToU8('A\n1'), 'leads.xlsx').rows).toEqual([['A'], ['1']]);
  });

  it('trims trailing empty columns and rows', () => {
    expect(readTable(strToU8('A,B,,\n1,2,,\n,,,\n'), 'x.csv').rows).toEqual([
      ['A', 'B'],
      ['1', '2'],
    ]);
  });

  it('refuses an empty file', () => {
    expect(() => readTable(new Uint8Array(0), 'x.csv')).toThrowError(expect.objectContaining({ code: 'EMPTY_FILE' }));
  });
});
