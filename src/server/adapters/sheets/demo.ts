/**
 * Google Sheets DEMO adapter (T11, R11). In DEMO there is no spreadsheet and no Apps Script: this
 * module plays the script's part and produces exactly the v1 push body the live script sends
 * (`sheetsPushSchema`), for a simulated Google Form response sheet whose columns follow the
 * workspace's active SheetMapping. No network, no randomness: rows are a pure function of the
 * batch id, so a replayed batch is byte-identical and dedupes as a replay.
 *
 * The default mapping below is what the simulator installs on a workspace that has none: a lead
 * form with name, phone, email, city, interest, and a WhatsApp consent checkbox whose notice text
 * is stored verbatim (P1). Every other row answers "Yes" to it, so consent capture is visible.
 */
import { demoPerson, pick } from '@/lib/demo/contacts';
import type { ConsentMapping } from '@/lib/schemas/ingest';
import type { FieldMap, SheetsPush } from '@/lib/schemas/webhooks';

export const DEMO_SHEET_FIELD_MAP = {
  name: 'Full name',
  phone: 'Phone number',
  email: 'Email address',
  city: 'City',
  category: 'Interested in',
} as const satisfies FieldMap;

export const DEMO_SHEET_CONSENT: ConsentMapping = {
  column: 'WhatsApp updates',
  truthyValues: ['Yes'],
  channel: 'WHATSAPP',
  purpose: 'MARKETING',
  noticeText: 'Yes, send me appointment reminders and offers on WhatsApp. I can reply STOP at any time to opt out.',
  noticeVersion: 'demo-form-v1',
};

const INTERESTS = ['Consultation', 'Price list', 'Book a visit', 'Call me back', 'Package details'] as const;

export function demoSheetId(workspaceSlug: string): string {
  return `demo-sheet-${workspaceSlug}`;
}

export type SimulatedSheetsInput = {
  sheetId: string;
  mappingVersion: number;
  fieldMap: FieldMap;
  /** The consent column of the active mapping, or null when it has none. */
  consentColumn: string | null;
  /** Becomes the push `eventId` and the prefix of every row key. */
  batchId: string;
  count: number;
  /** Submission time of the newest row; earlier rows are one minute apart. */
  submittedAt: Date;
};

export function buildSimulatedSheetsPush(input: SimulatedSheetsInput): SheetsPush {
  const rows = Array.from({ length: input.count }, (_, i) => {
    const seed = `sheets:${input.batchId}:${i}`;
    const person = demoPerson(seed);
    const fieldValues: Record<string, string> = {
      name: person.name,
      phone: person.phone,
      email: person.email,
      city: person.city,
      category: pick(`${seed}:interest`, INTERESTS),
    };
    const values: Record<string, string> = {};
    for (const [field, column] of Object.entries(input.fieldMap)) {
      const value = fieldValues[field];
      if (column && value !== undefined) values[column] = value;
    }
    if (input.consentColumn) values[input.consentColumn] = i % 2 === 0 ? 'Yes' : 'No';
    const submittedAt = new Date(input.submittedAt.getTime() - (input.count - 1 - i) * 60_000);
    return { rowKey: `${input.batchId}:row-${i + 1}`, submittedAt: submittedAt.toISOString(), values };
  });
  return { version: 1, eventId: input.batchId, sheetId: input.sheetId, mappingVersion: input.mappingVersion, rows };
}
