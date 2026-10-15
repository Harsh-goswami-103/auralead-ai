/**
 * Translates the DB-layer and security-primitive errors (which are plain Error subclasses so
 * those layers stay independent of src/lib/errors) into the AppError hierarchy that
 * `errorToHttp` renders. Everything else passes through unchanged.
 */
import { DbBusyError as AppDbBusyError, LeaseLostError as AppLeaseLostError, NotFoundError, PayloadTooLargeError, ValidationError } from '@/lib/errors';
import { LeaseLostError } from '@/server/db/fence';
import { TenantScopeError } from '@/server/db/scoped';
import { DbBusyError } from '@/server/db/tx';
import { RawBodyError } from '@/server/security/raw-body';

export function normalizeServerError(error: unknown): unknown {
  if (error instanceof TenantScopeError) return new NotFoundError({ message: error.message, cause: error });
  if (error instanceof DbBusyError) return new AppDbBusyError({ message: error.message, cause: error, retryAfterSeconds: 1 });
  if (error instanceof LeaseLostError) return new AppLeaseLostError({ message: error.message, cause: error });
  if (error instanceof RawBodyError) {
    return error.status === 413
      ? new PayloadTooLargeError({ message: error.message, cause: error })
      : new ValidationError({ code: error.code, message: error.message, cause: error });
  }
  return error;
}
