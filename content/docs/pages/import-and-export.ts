import type { DocPage } from '../format';

/**
 * File import and lead export (ADR-117, ADR-120, ADR-129). Facts are taken from
 * src/lib/schemas/lead-import.ts (limits, fields, attestation), src/lib/spreadsheet/types.ts,
 * src/server/services/leads/import.ts and export.ts, and the consent rules in
 * src/server/services/messaging/consent.ts and suppression.ts.
 */
export const importAndExport: DocPage = {
  slug: 'import-and-export',
  title: 'Import and export leads',
  summary:
    'Bring a list of businesses in from Excel or CSV, map its columns and see why any row was not imported. An owner may also record WhatsApp opt-ins from a list the business collected itself, under an attestation. Covers data sources, limits and exporting leads as CSV or Excel.',
  appliesTo: ['DEMO', 'LIVE'],
  checked: '2026-10-23',
  sections: [
    {
      id: 'import',
      title: 'Importing a spreadsheet',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Operators often already hold a list in Excel. The import page, `/dashboard/employee/<ws>/leads/import` (the **Import leads** link on the Leads page), brings it in through the same ingestion every source uses: phone numbers become E.164, duplicates are recognised across all sources, possible duplicates go to merge review, and each new lead is scored and enters the workspace pipeline.',
        },
        {
          kind: 'ordered',
          items: [
            'Press **Choose a file** (or drop it) and pick an .xlsx or .csv file. **Download sample workbook** gives a file with every column the page recognises, filled with fictitious businesses.',
            'The page reads the first sheet, shows the header and the first 20 rows, and suggests which column holds what from the header names. Change any choice. A row needs a business name and at least one valid phone number or email address.',
            'Choose where the list came from, add the opt-in details if you have the right to (see [WhatsApp opt-ins from a file](#import-consent)), and press the import button. The file is processed in the background, 200 rows at a time.',
            'Watch the progress, then read the counts and the reason for every row that was not imported.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Opening the page needs `leads.read`; uploading and confirming need `leads.import`, which owners and members hold and an operator holds when it was granted on the assignment. An import is visible only to the person who uploaded it. The page belongs to the Operator panel; the Client panel has no import page.',
        },
        {
          kind: 'table',
          caption: 'Limits of a file import',
          head: ['Limit', 'Value'],
          rows: [
            ['File', 'An .xlsx workbook or a UTF-8 CSV (comma separated) of at most 5 MB. The first sheet is read; formulas, colours and formatting are not interpreted, every cell is read as text, and Excel dates arrive as date numbers.'],
            ['Rows', 'At most 2,000 data rows below the header, and 64 columns. A larger file is refused with `TOO_MANY_ROWS`; split it.'],
            ['Requests', '10 uploads or confirmations a minute (the `leadImport` limit).'],
            ['Cells', 'A business name up to 300 characters, an email up to 320, a website up to 2,048, an address up to 1,000; a longer value rejects the row.'],
          ],
        },
        {
          kind: 'paragraph',
          text: 'A file the app cannot read is refused with 422 and a reason: `UNSUPPORTED_FILE_TYPE`, `FILE_TYPE_MISMATCH` (a workbook named .csv), `NOT_A_WORKBOOK`, `TOO_LARGE`, `TOO_MANY_COLUMNS`, `MALFORMED_CSV`, `FILE_ENCODING_INVALID`, `EMPTY_FILE`, `NO_HEADER` or `NO_DATA_ROWS`.',
        },
      ],
    },
    {
      id: 'mapping-and-results',
      title: 'Mapping and results',
      blocks: [
        {
          kind: 'list',
          items: [
            'The fields are business name, phone, email, website, address, city, category, rating, reviews, PIN code, and the two consent columns (WhatsApp opt-in and opt-in date). A field you leave unmapped is not imported. Suggestions come from English header names; a header in another language is simply left for you to map.',
            '**New leads** were created; **Already in your leads** matched an existing lead by phone, email or place and changed nothing; **Sent to duplicate review** matched more than one lead and waits for a person; **Not imported** lists rows by number with the reason: no business name, no valid phone number or email, or a value that is too long.',
            'Reasons keep the row number, a code and the field name only, never the cell values. Importing the same file twice finds every row as a duplicate.',
            'A file import earns no source-intent points in the score (the source is recorded as "imported from a file" and counts as unknown); the rest of the score works as for any lead.',
          ],
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'Imported rows are the operator\'s own data: DEMO does not label them Simulated. No provider is contacted by an import.',
        },
      ],
    },
    {
      id: 'import-consent',
      title: 'WhatsApp opt-ins from a file',
      blocks: [
        {
          kind: 'paragraph',
          text: 'By default an import records no consent, so imported leads are skipped with `NO_WHATSAPP_OPT_IN` until they write to you or an opt-in is recorded. A list your own business collected may carry a column that says who agreed to WhatsApp messages. That column is honoured only when every rule below holds; if it is not honoured the import still runs, with no consent recorded.',
        },
        {
          kind: 'ordered',
          items: [
            'You hold `consent.import`. A workspace owner holds it; members do not, and an operator holds it only when a platform administrator grants it on the assignment.',
            'The data source is "Our own customers or enquiries" (`OWN_CUSTOMERS`) or "Our own form, event or visiting cards" (`OWN_FORM_OR_EVENT`). A public directory (`PUBLIC_DIRECTORY`) or a list from another company (`THIRD_PARTY_LIST`) never counts, whatever the file says.',
            'You give the notice the people saw. It must name your business and the word WhatsApp, and it is stored word for word with its hash.',
            'You accept the attestation below, exactly as shown (it carries your business name).',
            'The opt-in date column is mapped. A date is day-first (14/09/2026), ISO (2026-09-14) or an Excel date, read in the workspace\'s time zone, and no opt-in date may be in the future.',
          ],
        },
        {
          kind: 'code',
          language: 'text',
          caption: 'The attestation, word for word (line breaks added for reading; your business name replaces <business>)',
          code: 'I confirm that each row marked as consented is a person who, on the date given, agreed to receive WhatsApp messages from <business> about its products and services after seeing the notice below;\nthat <business> collected this list itself (it was not bought or scraped);\nand that I can produce the evidence on request.\nI understand this import will not re-subscribe anyone who has replied STOP.',
        },
        {
          kind: 'list',
          items: [
            'A cell counts as opted in when it says yes, y, true, 1, opted in, opt in, opt-in, consented or agreed (case and spacing ignored). A row with such a cell, a readable date and a valid phone number gets an OPT_IN marketing consent on WhatsApp with the source `FILE_IMPORT`; the evidence names the import, the row, the person who attested and the hash of the notice.',
            'The column is **ignored** (no consent, the confirmation says why) when the attestation was not given, when you lack `consent.import` or when the data source is not your own. It is **refused** with 422, and the import stays in preview so you can fix it, when an opt-in or date column is not mapped (`CONSENT_COLUMN_NOT_MAPPED`, `CONSENT_DATE_NOT_MAPPED`), the notice lacks the business name or WhatsApp (`NOTICE_MISSING_BUSINESS`, `NOTICE_MISSING_WHATSAPP`), the attestation was edited (`ATTESTATION_MISMATCH`) or an opt-in date is in the future (`CONSENT_DATE_IN_FUTURE`).',
            'A row whose date is missing or unreadable, whose phone number is not valid, or that is waiting in duplicate review is imported without consent and noted.',
          ],
        },
        {
          kind: 'callout',
          tone: 'warning',
          text: 'A file never re-subscribes anyone. A contact who replied Stop is imported without consent and noted `SUPPRESSED_CONTACT`; no consent record is created, and the refusal is audited as `suppression.clear_refused` (reason `BACKFILLED_SOURCE`). Only a new opt-in collected after the Stop clears it. See [Messaging rules](/docs/messaging-rules#suppression).',
        },
        {
          kind: 'callout',
          tone: 'limit',
          text: 'A file is weaker evidence than a form, because the person who uploads it controls every cell. The attestation and the stored notice are what you would show if asked. This is not legal advice; see [Data and privacy](/docs/data-and-privacy#dpdp).',
        },
      ],
    },
    {
      id: 'import-files',
      title: 'What happens to the file',
      blocks: [
        {
          kind: 'list',
          items: [
            'The upload is read once. The parsed rows are written to a file in the storage folder (`imports/<workspace>/<import>.json`), never to the database, because a preview needs only 20 rows and the rest is personal data.',
            'That file is deleted when the import finishes or fails, or 24 hours after the upload, whichever comes first. An import left in preview for 24 hours becomes Expired. The import record keeps the counts, the row numbers with their reason codes, the data source, and for an attested import the notice and its hash.',
            'If a background job dies without reporting, the import shows Queued or Importing until the 24-hour cleanup ends it as failed (`IMPORT_STALLED`) and deletes the rows file.',
            'Erasing a lead on request also ends every import of the workspace that still holds a rows file, because rows cannot be matched to a person without reading them again. See [Data and privacy](/docs/data-and-privacy#erasure).',
          ],
        },
      ],
    },
    {
      id: 'lead-export',
      title: 'Exporting leads as CSV or Excel',
      blocks: [
        {
          kind: 'list',
          items: [
            'The Leads page (the Client panel\'s `/dashboard/user/leads` and the Operator panel\'s `/dashboard/employee/<ws>/leads`) exports the leads that match the filters on screen, including the handed-over filter. Choose **Download Excel** or **Download CSV**. It needs `leads.export`.',
            'A background job prepares the file. It stays ready for 24 hours and is then deleted. A workspace holds at most three exports that are preparing or ready (`EXPORT_LIMIT_REACHED`); a file holds at most 50,000 leads. A request with the same filters and format as an export still in flight reuses it.',
            'One row per lead: name, stage, score, source, phone, email, website and its status, city, category, address, rating, reviews, when it was added and the lead ID. Unknown values are empty cells, never guesses.',
            'In CSV a text cell that starts with =, +, -, @, a tab or a return gets a leading apostrophe, so a spreadsheet shows it as text. In Excel every text cell is written as plain text and no formula is ever written.',
            'The columns are those stored for the lead. A Places lead therefore carries its phone, address and rating until they expire after 30 days; see [Lead Finder](/docs/lead-finder#places-leads). The Lead Finder has its own, more limited Excel file.',
          ],
        },
      ],
    },
  ],
};
