/**
 * Redaction applied before anything is logged or persisted as a payload (plan §9 Logging:
 * WebhookEvent.payloadRedacted, AuditEvent summaries, JobAttempt errors, pino lines).
 *
 * Two layers:
 * 1. Keys: values under secret-like keys (password, token, authorization, cookie, signature,
 *    api keys, ...) and PII keys (phone, email, address, wa_id, ip, ...) are replaced whole.
 * 2. Text: every string anywhere is scanned for secret shapes (provider keys, JWTs, PEM keys,
 *    credential ciphertext, signatures, token-bearing URLs) and PII (emails, phone numbers,
 *    IPv4 addresses).
 * The input is never mutated. Errors become `{ name, message }` without the stack.
 */
export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 24;

// ---- text patterns (order matters: specific shapes before generic ones) -----------------------
const TEXT_RULES: Array<[RegExp, string]> = [
  // PEM private keys (Google service accounts).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // Authorization header values.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // Provider keys and tokens.
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bre_[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\bEAA[A-Za-z0-9]{20,}/g, REDACTED],
  [/\balx_[A-Za-z0-9]+_[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],
  // Credential ciphertext `v1.<kid>.<nonce>.<ct>.<tag>` (A33).
  [/\bv1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],
  // Signatures: Meta `sha256=<hex>`, Svix `v1,<base64>`.
  [/\bsha256=[0-9a-fA-F]{32,}/g, REDACTED],
  [/\bv1,[A-Za-z0-9+/]{20,}={0,2}/g, REDACTED],
  // Share, unsubscribe and invite credentials in paths (C2).
  [/(\/(?:quote|quote-share|unsubscribe|invite)\/)[A-Za-z0-9_-]{8,}/g, `$1${REDACTED}`],
  // Token-bearing query parameters.
  [
    /([?&](?:access_token|token|key|api_key|apikey|signature|sig|code|secret|hub\.verify_token|hub\.challenge|appsecret_proof)=)[^&\s#"']+/gi,
    `$1${REDACTED}`,
  ],
  // key=value / key: value secrets in free text.
  [
    /\b(password|passwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    `$1$2${REDACTED}`,
  ],
  // PII.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, REDACTED],
  [/(?<![\w.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\w.])/g, REDACTED],
  // Phone numbers: 10 to 15 digits, optionally with +, spaces, dashes or parentheses between.
  [/(?<![\w+-])\+?\(?\d(?:[\s()-]{0,2}\d){9,14}(?![\w-])/g, REDACTED],
];

export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of TEXT_RULES) out = out.replace(pattern, replacement);
  return out;
}

// ---- key rules ---------------------------------------------------------------------------------
const SECRET_KEYS = new Set([
  'password', 'passwd', 'pwd', 'passwordhash', 'secret', 'secrets', 'clientsecret', 'appsecret', 'token', 'accesstoken',
  'refreshtoken', 'idtoken', 'tokenhash', 'secrethash', 'apikey', 'xapikey', 'authorization', 'proxyauthorization', 'cookie',
  'setcookie', 'privatekey', 'signature', 'xhubsignature', 'xhubsignature256', 'svixsignature', 'pepper', 'keyring',
  'credentials', 'credentialskeyring', 'processingpayload', 'otp', 'verifytoken', 'sessionsecret', 'sharenoncekey',
  'suppressionpepper', 'testcontroltoken',
]);
const SECRET_SUFFIXES = ['token', 'secret', 'password', 'apikey', 'privatekey'];

const PII_KEYS = new Set([
  'phone', 'phones', 'phonee164', 'phoneraw', 'alternatephones', 'mobile', 'msisdn', 'waid', 'email', 'emails',
  'emailnormalized', 'emailaddress', 'contactplain', 'address', 'ip', 'ipaddress', 'remoteaddress',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

function isSecretKey(key: string): boolean {
  const k = normalizeKey(key);
  return SECRET_KEYS.has(k) || SECRET_SUFFIXES.some((s) => k.endsWith(s));
}

function isPiiKey(key: string): boolean {
  return PII_KEYS.has(normalizeKey(key));
}

// ---- deep walk ----------------------------------------------------------------------------------
function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  seen.add(value);
  try {
    if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1, seen));
    if (value instanceof Map) return walk(Object.fromEntries(value), depth, new WeakSet());
    if (value instanceof Set) return walk([...value], depth, new WeakSet());
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return REDACTED;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (isSecretKey(key)) out[key] = v === null || v === undefined ? v : REDACTED;
      else if (isPiiKey(key) && v !== null && v !== undefined && typeof v !== 'boolean') out[key] = REDACTED;
      else out[key] = walk(v, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** Returns a redacted deep copy. Strings are scanned, sensitive keys replaced, errors flattened. */
export function redact<T>(value: T): unknown {
  return walk(value, 0, new WeakSet());
}
