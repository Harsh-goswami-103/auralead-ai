/**
 * WhatsApp send port (plan §3 adapters/whatsapp, §4.4). The dispatch handler builds one request per
 * DispatchAttempt after its preflight committed SENDING, calls `send` outside any transaction and
 * settles the outcome in a fenced transaction.
 *
 * A transport never throws for a provider answer: it returns a `SendOutcome` classified through
 * the dated error map (`error-map.ts`). `sent` needs a provider message id; `failed` carries the
 * failure class (E7); `ambiguous` means the request may have reached the provider (no blind
 * resend). A thrown error is treated by the caller as ambiguous.
 *
 * Implementations: `demo.ts` (DEMO: records the would-be send, labelled simulated, zero network)
 * and the Cloud API adapter (T32, LIVE only, through `adapters/http/outbound.ts`).
 */
export type FailureClass = 'PRE_SEND' | 'RETRYABLE' | 'PERMANENT';

export type SentOutcome = { status: 'sent'; providerMessageId: string; simulated: boolean };
export type FailedOutcome = {
  status: 'failed';
  failureClass: FailureClass;
  reasonCode: string;
  /** Redacted, at most 500 characters. */
  error: string;
  retryAfterMs?: number;
  /** The error map says the provider reported an opt-out (131050): suppress the contact. */
  suppress: boolean;
  /** A person may retry only after this long (131049, C16). */
  manualRetryAfterMs: number | null;
  /** 429-style throttles also defer later preflights for the workspace or the pair. */
  throttleScope: 'workspace' | 'pair' | null;
};
export type AmbiguousOutcome = { status: 'ambiguous'; reasonCode: string; error: string };
export type SendOutcome = SentOutcome | FailedOutcome | AmbiguousOutcome;

export type WaDocument = { filename: string; mimeType: 'application/pdf'; bytes: Buffer; sha256: string };

export type WaSendRequest = {
  /** Echoed as `biz_opaque_callback_data` so a status webhook can resolve AMBIGUOUS (UNVERIFIED). */
  attemptId: string;
  idempotencyKey: string;
  workspaceId: string;
  /** E.164 recipient. */
  to: string;
  kind: 'template' | 'freeform';
  template: { name: string; language: string; variables: Record<string, string> } | null;
  body: string | null;
  document: WaDocument | null;
};

export interface WhatsAppTransport {
  readonly label: 'demo' | 'cloud-api';
  readonly simulated: boolean;
  send(request: WaSendRequest): Promise<SendOutcome>;
}
