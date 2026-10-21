/**
 * The Apps Script generator (T34; plan §11 T34, §9 Webhooks, PRD "Generate copyable Apps Script
 * (setup, mapping, event IDs, auth, retry guidance)"). Pure: returns the text of one `Code.gs` for
 * a workspace's Sheet and its active column mapping.
 *
 * What the script does (it is the only thing that pushes rows; a Sheet URL alone grants nothing):
 *  - Menu "AuraLead": Set signing secret (prompted, stored in Script Properties, never in a cell
 *    and never in this text), Set up (adds the hidden, warning-protected `auralead_event_id`
 *    column, gives every row a stable id once, installs the form-submit and 15-minute retry
 *    triggers), Send queued rows now.
 *  - On each form submit: the row's `auralead_event_id` (written once, reused for every later
 *    send of that row, so an edit or a double trigger never creates a second lead), the mapped
 *    columns only, the submission time, and row 1 for the drift check, as one signed push.
 *  - Signing: `X-AuraLead-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + eventId + "." +
 *    body)>`; the body is pure ASCII (non-ASCII as \u escapes), so no charset can change the
 *    signed bytes.
 *  - Retries: `muteHttpExceptions`, no redirects, exponential backoff with jitter on network
 *    errors, 429 (honouring Retry-After) and 5xx, re-signed each attempt with the same event id;
 *    no retry on other 4xx. Unsent rows wait in Script Properties (at most 200 ids) and the
 *    15-minute trigger sends them in pushes of at most 50 rows; 400/413/422 drop the row (resending
 *    cannot fix it), every other failure keeps it (a 401 after a secret change, a 409 after a
 *    mapping change).
 * Every embedded value goes through `literal()` (JSON string syntax, line separators escaped), so a
 * hostile column or tab name stays a string.
 */
import { SHEETS_EVENT_ID_COLUMN } from '@/lib/schemas/sheets';
import { SHEETS_MAX_ROWS } from '@/lib/schemas/webhooks';
import { SHEETS_SIGNATURE_HEADERS } from './signature';

export type AppsScriptInput = {
  /** `${APP_ORIGIN}/api/webhooks/google-sheets` */
  endpoint: string;
  keyId: string;
  sheetId: string;
  /** The tab with the form responses; null means the first tab. */
  sheetName: string | null;
  mappingVersion: number;
  /** Mapped columns (fields, consent and submission time), the only ones the script sends. */
  columns: readonly string[];
  submittedAtColumn: string | null;
  generatedAt: Date;
};

export const APPS_SCRIPT_SECRET_PROPERTY = 'AURALEAD_SECRET';
export const APPS_SCRIPT_PENDING_PROPERTY = 'AURALEAD_PENDING';
export const APPS_SCRIPT_RETRY_MINUTES = 15;
export const APPS_SCRIPT_MAX_ATTEMPTS = 4;
export const APPS_SCRIPT_MAX_PENDING = 200;

function literal(value: unknown): string {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return JSON.stringify(value).split(LS).join('\\u2028').split(PS).join('\\u2029');
}

export function generateAppsScript(input: AppsScriptInput): string {
  const config = [
    `  endpoint: ${literal(input.endpoint)},`,
    `  keyId: ${literal(input.keyId)},`,
    `  sheetId: ${literal(input.sheetId)},`,
    `  sheetName: ${literal(input.sheetName)},`,
    `  mappingVersion: ${literal(input.mappingVersion)},`,
    `  columns: ${literal([...input.columns])},`,
    `  submittedAtColumn: ${literal(input.submittedAtColumn)},`,
    `  eventIdColumn: ${literal(SHEETS_EVENT_ID_COLUMN)},`,
    `  maxRowsPerPush: ${SHEETS_MAX_ROWS},`,
    `  maxAttempts: ${APPS_SCRIPT_MAX_ATTEMPTS},`,
    `  maxPending: ${APPS_SCRIPT_MAX_PENDING},`,
    `  retryMinutes: ${APPS_SCRIPT_RETRY_MINUTES},`,
    `  secretProperty: ${literal(APPS_SCRIPT_SECRET_PROPERTY)},`,
    `  pendingProperty: ${literal(APPS_SCRIPT_PENDING_PROPERTY)}`,
  ].join('\n');
  const h = SHEETS_SIGNATURE_HEADERS;
  return `/**
 * AuraLead AI: Google Sheets push. Generated ${input.generatedAt.toISOString()} for column mapping v${input.mappingVersion}.
 * Requires the V8 runtime (the default for new Apps Script projects).
 *
 * Setup, once:
 *  1. In the Sheet with the form responses: Extensions > Apps Script. Replace Code.gs with this file and save.
 *  2. Reload the Sheet, then AuraLead > Set signing secret. Paste the secret AuraLead showed you once.
 *     It is kept in Script Properties; it is never written to the Sheet.
 *  3. AuraLead > Set up. This adds a hidden "${SHEETS_EVENT_ID_COLUMN}" column, gives every row a
 *     stable id and installs the form-submit and retry triggers. Approve the permissions Google asks for.
 *     Existing rows are not sent: use "Sync now" in AuraLead for them.
 *
 * Each new form response is sent, signed with HMAC-SHA256, to AuraLead. Network errors, 429 and 5xx
 * are retried with exponential backoff; other 4xx are not retried. Rows that could not be sent wait in
 * Script Properties and are retried every ${APPS_SCRIPT_RETRY_MINUTES} minutes (at most ${SHEETS_MAX_ROWS} rows per push).
 * If AuraLead answers that the mapping changed (409), copy the new script from AuraLead: queued rows are kept.
 * Do not edit or delete the ${SHEETS_EVENT_ID_COLUMN} column: it is how a row is recognised when it is sent again.
 */
var AURALEAD = {
${config}
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('AuraLead')
    .addItem('Set signing secret', 'auraleadSetSecret')
    .addItem('Set up', 'auraleadSetup')
    .addItem('Send queued rows now', 'auraleadFlushPending')
    .addToUi();
}

function auraleadSetSecret() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('AuraLead signing secret', 'Paste the signing secret AuraLead showed you. It is stored in Script Properties, not in the Sheet.', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var secret = String(res.getResponseText() || '').trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
    ui.alert('That is not an AuraLead signing secret. Nothing was saved.');
    return;
  }
  PropertiesService.getScriptProperties().setProperty(AURALEAD.secretProperty, secret);
  ui.alert('Signing secret saved in Script Properties.');
}

function auraleadSetup() {
  if (!PropertiesService.getScriptProperties().getProperty(AURALEAD.secretProperty)) {
    throw new Error('AuraLead: set the signing secret first (AuraLead > Set signing secret).');
  }
  var sheet = auraleadSheet_();
  var header = auraleadHeader_(sheet);
  var missing = AURALEAD.columns.filter(function (c) { return header.indexOf(c) < 0; });
  if (missing.length) {
    throw new Error('AuraLead: these mapped columns are not in row 1: ' + missing.join(', ') + '. Re-confirm the mapping in AuraLead and copy the new script.');
  }
  var col = auraleadEventIdColumn_(sheet, true);
  var last = sheet.getLastRow();
  if (last >= 2) {
    var range = sheet.getRange(2, col, last - 1, 1);
    var ids = range.getValues();
    var changed = false;
    for (var i = 0; i < ids.length; i++) {
      if (!auraleadNormalize_(ids[i][0])) {
        ids[i][0] = Utilities.getUuid();
        changed = true;
      }
    }
    if (changed) range.setValues(ids);
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'auraleadOnFormSubmit' || fn === 'auraleadFlushPending') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('auraleadOnFormSubmit').forSpreadsheet(AURALEAD.sheetId).onFormSubmit().create();
  ScriptApp.newTrigger('auraleadFlushPending').timeBased().everyMinutes(AURALEAD.retryMinutes).create();
}

function auraleadOnFormSubmit(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = auraleadSheet_();
    if (e && e.range && e.range.getSheet().getSheetId() !== sheet.getSheetId()) return;
    var row = e && e.range ? e.range.getRow() : sheet.getLastRow();
    if (row < 2) return;
    var id = auraleadEnsureEventId_(sheet, row);
    var header = auraleadHeader_(sheet);
    var result = auraleadSend_([auraleadRow_(sheet, header, row, id, true)], header);
    if (!result.delivered && result.keep) auraleadQueue_([id]);
  } finally {
    lock.releaseLock();
  }
}

function auraleadFlushPending() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    var props = PropertiesService.getScriptProperties();
    var queue = auraleadPending_(props);
    if (!queue.length) return;
    var sheet = auraleadSheet_();
    var col = auraleadEventIdColumn_(sheet, false);
    if (!col) return;
    var header = auraleadHeader_(sheet);
    var last = sheet.getLastRow();
    var cells = last >= 2 ? sheet.getRange(2, col, last - 1, 1).getValues() : [];
    var rowOf = {};
    for (var i = 0; i < cells.length; i++) {
      var key = auraleadNormalize_(cells[i][0]);
      if (key) rowOf[key] = i + 2;
    }
    var batch = queue.slice(0, AURALEAD.maxRowsPerPush);
    var rows = [];
    var found = [];
    batch.forEach(function (id) {
      if (rowOf[id]) {
        rows.push(auraleadRow_(sheet, header, rowOf[id], id, false));
        found.push(id);
      }
    });
    var remaining = queue.slice(AURALEAD.maxRowsPerPush);
    if (rows.length) {
      var result = auraleadSend_(rows, header);
      if (!result.delivered && result.keep) remaining = found.concat(remaining);
    }
    props.setProperty(AURALEAD.pendingProperty, JSON.stringify(remaining));
  } finally {
    lock.releaseLock();
  }
}

function auraleadSheet_() {
  var ss = SpreadsheetApp.openById(AURALEAD.sheetId);
  var sheet = AURALEAD.sheetName ? ss.getSheetByName(AURALEAD.sheetName) : ss.getSheets()[0];
  if (!sheet) throw new Error('AuraLead: the tab ' + JSON.stringify(AURALEAD.sheetName) + ' is not in this spreadsheet.');
  return sheet;
}

function auraleadNormalize_(value) {
  if (value === null || value === undefined) return '';
  return String(value).normalize('NFKC').replace(/\\s+/g, ' ').trim().slice(0, 200);
}

function auraleadIsDate_(value) {
  return Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime());
}

function auraleadHeader_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(auraleadNormalize_);
}

function auraleadEventIdColumn_(sheet, create) {
  var header = auraleadHeader_(sheet);
  var index = header.indexOf(AURALEAD.eventIdColumn);
  if (index >= 0) return index + 1;
  if (!create) return 0;
  var col = header.length + 1;
  sheet.getRange(1, col).setValue(AURALEAD.eventIdColumn);
  sheet.hideColumns(col);
  sheet.getRange(1, col, sheet.getMaxRows(), 1).protect().setDescription('AuraLead event ids: do not edit').setWarningOnly(true);
  return col;
}

function auraleadEnsureEventId_(sheet, row) {
  var col = auraleadEventIdColumn_(sheet, true);
  var cell = sheet.getRange(row, col);
  var id = auraleadNormalize_(cell.getValue());
  if (!id) {
    id = Utilities.getUuid();
    cell.setValue(id);
  }
  return id;
}

function auraleadRow_(sheet, header, row, eventId, justSubmitted) {
  var cells = sheet.getRange(row, 1, 1, Math.max(1, header.length)).getValues()[0];
  var values = {};
  var submittedAt = null;
  for (var i = 0; i < header.length; i++) {
    var name = header[i];
    if (!name || AURALEAD.columns.indexOf(name) < 0) continue;
    var cell = cells[i];
    if (auraleadIsDate_(cell)) {
      if (name === AURALEAD.submittedAtColumn) submittedAt = cell.toISOString();
      values[name] = cell.toISOString();
    } else if (cell === '' || cell === null || cell === undefined) {
      values[name] = null;
    } else if (typeof cell === 'number' || typeof cell === 'boolean') {
      values[name] = cell;
    } else {
      values[name] = String(cell).slice(0, 2000);
    }
  }
  if (!submittedAt && justSubmitted) submittedAt = new Date().toISOString();
  var out = { rowKey: eventId, values: values };
  if (submittedAt) out.submittedAt = submittedAt;
  return out;
}

function auraleadAscii_(json) {
  return json.replace(/[\\u007f-\\uffff]/g, function (c) {
    return '\\\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

function auraleadHex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += ('0' + (bytes[i] & 0xff).toString(16)).slice(-2);
  return out;
}

function auraleadSend_(rows, header) {
  var secret = PropertiesService.getScriptProperties().getProperty(AURALEAD.secretProperty);
  if (!secret) {
    console.error('AuraLead: no signing secret is set (AuraLead > Set signing secret); the row is queued.');
    return { delivered: false, keep: true, code: 0 };
  }
  var eventId = Utilities.getUuid();
  var body = auraleadAscii_(JSON.stringify({
    version: 1,
    eventId: eventId,
    sheetId: AURALEAD.sheetId,
    mappingVersion: AURALEAD.mappingVersion,
    header: header.filter(function (name) { return name && name !== AURALEAD.eventIdColumn; }),
    rows: rows
  }));
  var code = 0;
  var text = '';
  for (var attempt = 1; attempt <= AURALEAD.maxAttempts; attempt++) {
    var timestamp = String(Math.floor(Date.now() / 1000));
    var signature = 'v1=' + auraleadHex_(Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_256, timestamp + '.' + eventId + '.' + body, secret, Utilities.Charset.UTF_8));
    var headers = {};
    headers[${literal(h.keyId)}] = AURALEAD.keyId;
    headers[${literal(h.timestamp)}] = timestamp;
    headers[${literal(h.eventId)}] = eventId;
    headers[${literal(h.signature)}] = signature;
    var response = null;
    try {
      response = UrlFetchApp.fetch(AURALEAD.endpoint, {
        method: 'post',
        contentType: 'application/json',
        payload: body,
        headers: headers,
        muteHttpExceptions: true,
        followRedirects: false
      });
    } catch (err) {
      response = null;
    }
    code = response ? response.getResponseCode() : 0;
    if (code >= 200 && code < 300) return { delivered: true, keep: false, code: code };
    text = response ? String(response.getContentText() || '').slice(0, 300) : 'network error';
    var retryable = code === 0 || code === 429 || code >= 500;
    if (!retryable) break;
    if (attempt < AURALEAD.maxAttempts) {
      var wait = 1000 * Math.pow(2, attempt - 1);
      var retryAfter = response ? Number((response.getHeaders() || {})['Retry-After']) : NaN;
      if (retryAfter > 0) wait = Math.max(wait, retryAfter * 1000);
      Utilities.sleep(Math.min(30000, wait) + Math.floor(Math.random() * 500));
    }
  }
  console.error('AuraLead: push not accepted (HTTP ' + code + '): ' + text);
  return { delivered: false, keep: !(code === 400 || code === 413 || code === 422), code: code };
}

function auraleadPending_(props) {
  try {
    var parsed = JSON.parse(props.getProperty(AURALEAD.pendingProperty) || '[]');
    return Array.isArray(parsed) ? parsed.filter(function (x) { return typeof x === 'string'; }) : [];
  } catch (err) {
    return [];
  }
}

function auraleadQueue_(ids) {
  var props = PropertiesService.getScriptProperties();
  var queue = auraleadPending_(props);
  ids.forEach(function (id) {
    if (queue.indexOf(id) < 0) queue.push(id);
  });
  if (queue.length > AURALEAD.maxPending) {
    console.warn('AuraLead: more than ' + AURALEAD.maxPending + ' rows are waiting; the oldest were dropped from the retry queue. Use Sync now in AuraLead.');
    queue = queue.slice(queue.length - AURALEAD.maxPending);
  }
  props.setProperty(AURALEAD.pendingProperty, JSON.stringify(queue));
}
`;
}
