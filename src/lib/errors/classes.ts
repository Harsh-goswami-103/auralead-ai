/**
 * The AppError hierarchy (02-errors §2.1 as amended by plan §4-§9). Statuses: tenant misses are
 * 404 (never 403, A6); in-tenant capability failures 403; domain rules 422; state conflicts 409.
 * tests/unit/lib/errors-http.test.ts pins every class to its status, code and retryability.
 */
import { AppError, type AppErrorOptions } from './app-error';

// ---- 400 validation ---------------------------------------------------------------------------
export class ValidationError extends AppError {
  static override readonly status: number = 400;
  static override readonly defaultCode: string = 'VALIDATION_FAILED';
  static override readonly defaultUserMessage: string = 'Some fields are missing or invalid.';
}
export class PayloadTooLargeError extends ValidationError {
  static override readonly status: number = 413;
  static override readonly defaultCode: string = 'PAYLOAD_TOO_LARGE';
  static override readonly defaultUserMessage: string = 'The request body is too large.';
}
export class TemplateVariableInvalidError extends ValidationError {
  static override readonly status: number = 422;
  static override readonly defaultCode: string = 'TEMPLATE_VARIABLE_INVALID';
  static override readonly defaultUserMessage: string = 'A template variable is empty, too long, or contains characters WhatsApp does not allow.';
}

// ---- 401 authentication -----------------------------------------------------------------------
export class AuthError extends AppError {
  static override readonly status: number = 401;
  static override readonly defaultCode: string = 'UNAUTHENTICATED';
  static override readonly defaultUserMessage: string = 'Sign in to continue.';
}
export class SignatureInvalidError extends AuthError {
  static override readonly defaultCode: string = 'SIGNATURE_INVALID';
  static override readonly defaultUserMessage: string = 'The request signature is invalid.';
}
export class ReplayDetectedError extends AuthError {
  static override readonly status: number = 409;
  static override readonly defaultCode: string = 'REPLAY_DETECTED';
  static override readonly defaultUserMessage: string = 'This request was already received or is too old.';
}
export class IngestionTokenRevokedError extends AuthError {
  static override readonly defaultCode: string = 'TOKEN_REVOKED';
  static override readonly defaultUserMessage: string = 'This token is revoked or expired.';
}

// ---- 404 / 403 --------------------------------------------------------------------------------
export class NotFoundError extends AppError {
  static override readonly status: number = 404;
  static override readonly defaultCode: string = 'NOT_FOUND';
  static override readonly defaultUserMessage: string = 'Not found.';
}
/** A referenced id belongs to another workspace. Renders exactly like NotFoundError (A6). */
export class TenantScopeError extends NotFoundError {}

export class PermissionDeniedError extends AppError {
  static override readonly status: number = 403;
  static override readonly defaultCode: string = 'FORBIDDEN';
  static override readonly defaultUserMessage: string = 'You do not have permission to do this.';
}
export class CsrfError extends AppError {
  static override readonly status: number = 403;
  static override readonly defaultCode: string = 'CSRF_FAILED';
  static override readonly defaultUserMessage: string = 'The request could not be verified. Reload the page and try again.';
}

// ---- 429 --------------------------------------------------------------------------------------
export class RateLimitedError extends AppError {
  static override readonly status: number = 429;
  static override readonly defaultCode: string = 'RATE_LIMITED';
  static override readonly defaultRetryable: boolean = true;
  static override readonly defaultUserMessage: string = 'Too many requests. Wait a moment and try again.';
}

// ---- 409 conflicts ----------------------------------------------------------------------------
export class ConflictError extends AppError {
  static override readonly status: number = 409;
  static override readonly defaultCode: string = 'CONFLICT';
  static override readonly defaultUserMessage: string = 'This changed while you were working. Reload and try again.';
}
export class IdempotencyConflictError extends ConflictError {
  static override readonly defaultCode: string = 'IDEMPOTENCY_CONFLICT';
  static override readonly defaultUserMessage: string = 'This request id was already used with different content.';
}
export class QuoteVersionConflictError extends ConflictError {
  static override readonly defaultCode: string = 'QUOTE_VERSION_CONFLICT';
  static override readonly defaultUserMessage: string = 'The quote has a newer version. Reload to see it.';
}
export class InvalidTransitionError extends ConflictError {
  static override readonly defaultCode: string = 'INVALID_TRANSITION';
  static override readonly defaultUserMessage: string = 'That action is not allowed in the current state.';
}
export class ApprovalStaleError extends ConflictError {
  static override readonly defaultCode: string = 'APPROVAL_STALE';
  static override readonly defaultUserMessage: string = 'The content changed after approval. Approve it again.';
}
/** SQLITE_BUSY persisted after busy_timeout and the withTx retries. */
export class DbBusyError extends ConflictError {
  static override readonly status: number = 503;
  static override readonly defaultCode: string = 'DB_BUSY';
  static override readonly defaultRetryable: boolean = true;
  static override readonly defaultUserMessage: string = 'The system is busy. Try again in a moment.';
}

// ---- 422 domain rules -------------------------------------------------------------------------
export class DomainRuleError extends AppError {
  static override readonly status: number = 422;
  static override readonly defaultCode: string = 'DOMAIN_RULE_VIOLATED';
  static override readonly defaultUserMessage: string = 'This action breaks a business rule.';
}
export class PricingMissingError extends DomainRuleError {
  static override readonly defaultCode: string = 'PRICING_MISSING';
  static override readonly defaultUserMessage: string = 'A service has no active price.';
}
export class DiscountLimitExceededError extends DomainRuleError {
  static override readonly defaultCode: string = 'DISCOUNT_OVER_LIMIT';
  static override readonly defaultUserMessage: string = 'The discount is above the allowed limit.';
}
export class DiscountInvalidError extends DomainRuleError {
  static override readonly defaultCode: string = 'DISCOUNT_INVALID';
  static override readonly defaultUserMessage: string = 'The discount must be between 0 and 100%, and a flat discount cannot exceed the subtotal.';
}
export class AmountInvalidError extends DomainRuleError {
  static override readonly defaultCode: string = 'AMOUNT_INVALID';
  static override readonly defaultUserMessage: string = 'An amount, quantity or rate is invalid.';
}
export class ServiceNotApprovedError extends DomainRuleError {
  static override readonly defaultCode: string = 'SERVICE_NOT_APPROVED';
  static override readonly defaultUserMessage: string = 'A referenced service is unknown or archived.';
}
export class SuppressedRecipientError extends DomainRuleError {
  static override readonly defaultCode: string = 'SUPPRESSED';
  static override readonly defaultUserMessage: string = 'This contact opted out on this channel.';
}
export class ConsentMissingError extends DomainRuleError {
  static override readonly defaultCode: string = 'CONSENT_MISSING';
  static override readonly defaultUserMessage: string = 'There is no recorded consent for this channel.';
}
export class WindowClosedError extends DomainRuleError {
  static override readonly defaultCode: string = 'WINDOW_CLOSED';
  static override readonly defaultUserMessage: string = 'The 24-hour reply window is closed. Use an approved template.';
}
export class TemplateNotApprovedError extends DomainRuleError {
  static override readonly defaultCode: string = 'TEMPLATE_NOT_APPROVED';
  static override readonly defaultUserMessage: string = 'The template is not approved by WhatsApp.';
}
export class HumanTakeoverActiveError extends DomainRuleError {
  static override readonly defaultCode: string = 'HUMAN_TAKEOVER';
  static override readonly defaultUserMessage: string = 'A person has taken over this conversation.';
}
export class OutboundPausedError extends DomainRuleError {
  static override readonly defaultCode: string = 'OUTBOUND_PAUSED';
  static override readonly defaultUserMessage: string = 'Outbound messaging is paused.';
}
/** Expired or superseded share link (ADR-09: 410 naming the sender). */
export class ShareLinkGoneError extends DomainRuleError {
  static override readonly status: number = 410;
  static override readonly defaultCode: string = 'SHARE_LINK_GONE';
  static override readonly defaultUserMessage: string = 'This quote link is no longer valid. Ask the sender for a new one.';
}

// ---- integrations -----------------------------------------------------------------------------
export class IntegrationError extends AppError {
  static override readonly status: number = 409;
  static override readonly defaultCode: string = 'INTEGRATION_ERROR';
  static override readonly defaultUserMessage: string = 'The integration is not ready.';
}
export class IntegrationNotConfiguredError extends IntegrationError {
  static override readonly defaultCode: string = 'INTEGRATION_NOT_CONFIGURED';
  static override readonly defaultUserMessage: string = 'This integration is not configured. Set it up under Integrations.';
}
/** A provider write needs a verified integration (T35 campaign controls, AT14): 412, the adapter is not called. */
export class IntegrationNotVerifiedError extends IntegrationError {
  static override readonly status: number = 412;
  static override readonly defaultCode: string = 'INTEGRATION_NOT_VERIFIED';
  static override readonly defaultUserMessage: string = 'This integration has not been verified with the provider. Test the connection on its setup page first.';
}
export class CredentialDecryptError extends IntegrationError {
  static override readonly status: number = 500;
  static override readonly defaultCode: string = 'CREDENTIAL_DECRYPT_FAILED';
  static override readonly defaultUserMessage: string = 'Stored credentials could not be read. Re-enter them under Integrations.';
}
export class ModeMismatchError extends IntegrationError {
  static override readonly defaultCode: string = 'MODE_MISMATCH';
  static override readonly defaultUserMessage: string = 'This action is not available in the current mode.';
}
/** DEMO tripwire: any outbound host call in DEMO (plan §4.2). */
export class OutboundBlockedInDemoError extends IntegrationError {
  static override readonly status: number = 500;
  static override readonly defaultCode: string = 'OUTBOUND_BLOCKED_IN_DEMO';
  static override readonly defaultUserMessage: string = 'Demo mode never contacts external services.';
}

// ---- providers --------------------------------------------------------------------------------
export type ProviderErrorOptions = AppErrorOptions & {
  provider?: string;
  providerCode?: string;
  httpStatus?: number;
};

export class ProviderError extends AppError {
  static override readonly status: number = 502;
  static override readonly defaultCode: string = 'PROVIDER_ERROR';
  static override readonly defaultUserMessage: string = 'The provider returned an error.';
  readonly provider: string | undefined;
  readonly providerCode: string | undefined;
  readonly httpStatus: number | undefined;
  constructor(opts: ProviderErrorOptions = {}) {
    super(opts);
    this.provider = opts.provider;
    this.providerCode = opts.providerCode;
    this.httpStatus = opts.httpStatus;
  }
}
export class ProviderAuthError extends ProviderError {
  static override readonly defaultCode: string = 'PROVIDER_AUTH';
  static override readonly defaultUserMessage: string = 'The provider rejected the stored credentials. Reconnect the integration.';
}
export class ProviderPermissionError extends ProviderError {
  static override readonly defaultCode: string = 'PROVIDER_PERMISSION';
  static override readonly defaultUserMessage: string = 'The provider account is missing a required permission.';
}
export class ProviderRateLimitedError extends ProviderError {
  static override readonly status: number = 503;
  static override readonly defaultCode: string = 'PROVIDER_RATE_LIMITED';
  static override readonly defaultRetryable: boolean = true;
  static override readonly defaultUserMessage: string = 'The provider is throttling requests. It will be retried.';
}
export class ProviderUnavailableError extends ProviderError {
  static override readonly status: number = 503;
  static override readonly defaultCode: string = 'PROVIDER_UNAVAILABLE';
  static override readonly defaultRetryable: boolean = true;
  static override readonly defaultUserMessage: string = 'The provider is unavailable. It will be retried.';
}
export class ProviderRejectedError extends ProviderError {
  static override readonly defaultCode: string = 'PROVIDER_REJECTED';
  static override readonly defaultUserMessage: string = 'The provider rejected the request.';
}
export class ProviderTimeoutSafeError extends ProviderError {
  static override readonly status: number = 504;
  static override readonly defaultCode: string = 'PROVIDER_TIMEOUT';
  static override readonly defaultRetryable: boolean = true;
  static override readonly defaultUserMessage: string = 'The provider timed out. It will be retried.';
}
/** Timeout after the request was written: never retried automatically (no blind resend). */
export class ProviderTimeoutAmbiguousError extends ProviderError {
  static override readonly status: number = 504;
  static override readonly defaultCode: string = 'PROVIDER_TIMEOUT_AMBIGUOUS';
  static override readonly defaultUserMessage: string = 'Delivery unknown: the provider did not confirm in time.';
}

// ---- AI ---------------------------------------------------------------------------------------
export class AiError extends AppError {
  static override readonly status: number = 502;
  static override readonly defaultCode: string = 'AI_ERROR';
  static override readonly defaultUserMessage: string = 'The AI draft could not be generated.';
}
export class AiMalformedOutputError extends AiError {
  static override readonly defaultCode: string = 'AI_MALFORMED_OUTPUT';
  static override readonly defaultRetryable: boolean = true;
}
export class AiEmptyOutputError extends AiError {
  static override readonly defaultCode: string = 'AI_EMPTY_OUTPUT';
  static override readonly defaultRetryable: boolean = true;
}
export class AiTruncatedOutputError extends AiError {
  static override readonly defaultCode: string = 'AI_TRUNCATED_OUTPUT';
  static override readonly defaultRetryable: boolean = true;
}
export class AiRefusalError extends AiError {
  static override readonly defaultCode: string = 'AI_REFUSAL';
  static override readonly defaultUserMessage: string = 'The AI provider declined to write this draft. Write it manually.';
}
export class AiPolicyViolationError extends AiError {
  static override readonly status: number = 422;
  static override readonly defaultCode: string = 'AI_POLICY_VIOLATION';
  static override readonly defaultUserMessage: string = 'The AI output broke a content rule and needs review.';
}

// ---- enrichment -------------------------------------------------------------------------------
export class EnrichmentError extends AppError {
  static override readonly status: number = 502;
  static override readonly defaultCode: string = 'ENRICHMENT_FAILED';
  static override readonly defaultUserMessage: string = 'The website could not be checked.';
}
export class EnrichmentBlockedDestinationError extends EnrichmentError {
  static override readonly status: number = 422;
  static override readonly defaultCode: string = 'ENRICHMENT_BLOCKED_DESTINATION';
  static override readonly defaultUserMessage: string = 'That address is not allowed to be fetched.';
}
export class EnrichmentTooLargeError extends EnrichmentError {
  static override readonly defaultCode: string = 'ENRICHMENT_TOO_LARGE';
}
export class EnrichmentTimeoutError extends EnrichmentError {
  static override readonly status: number = 504;
  static override readonly defaultCode: string = 'ENRICHMENT_TIMEOUT';
  static override readonly defaultRetryable: boolean = true;
}
export class EnrichmentFetchError extends EnrichmentError {
  static override readonly defaultCode: string = 'ENRICHMENT_FETCH_FAILED';
  static override readonly defaultRetryable: boolean = true;
}

// ---- PDF and jobs -----------------------------------------------------------------------------
export class PdfRenderError extends AppError {
  static override readonly status: number = 500;
  static override readonly defaultCode: string = 'PDF_RENDER_FAILED';
  static override readonly defaultRetryable: boolean = true;
  static override readonly defaultUserMessage: string = 'The PDF is not ready yet. It will be generated again.';
}

export class JobError extends AppError {
  static override readonly status: number = 500;
  static override readonly defaultCode: string = 'JOB_ERROR';
}
/** claimToken fence matched zero rows (E5, ADR-39): roll back before any domain write. */
export class LeaseLostError extends JobError {
  static override readonly status: number = 409;
  static override readonly defaultCode: string = 'LEASE_LOST';
}
export class JobCancelledError extends JobError {
  static override readonly status: number = 409;
  static override readonly defaultCode: string = 'JOB_CANCELLED';
}
export class MaxAttemptsExceededError extends JobError {
  static override readonly defaultCode: string = 'MAX_ATTEMPTS_EXCEEDED';
}

// ---- configuration and fallback ---------------------------------------------------------------
/** Test control (DbOffsetClock, /api/test/*) requested outside DEMO + flag + token (A40). */
export class TestControlNotAllowedError extends AppError {
  static override readonly status: number = 500;
  static override readonly defaultCode: string = 'TEST_CONTROL_NOT_ALLOWED';
}

/** Anything that is not an AppError is reported to users as this. */
export class InternalError extends AppError {}
