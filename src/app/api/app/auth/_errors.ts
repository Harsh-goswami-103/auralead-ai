import { AuthError } from '@/lib/errors';

/** The single answer for every failed credential check (no user enumeration). */
export function invalidCredentials(): AuthError {
  return new AuthError({ code: 'INVALID_CREDENTIALS', userMessage: 'Email or password is incorrect.' });
}
