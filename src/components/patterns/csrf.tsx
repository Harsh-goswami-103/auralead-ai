'use client';

/**
 * The session's CSRF token for client components inside a panel (withRoute checks it on every
 * cookie-authenticated mutation). Set once by PanelShell from the server page context.
 */
import { createContext, useContext, type ReactNode } from 'react';

const CsrfContext = createContext<string | null>(null);

export function CsrfProvider({ token, children }: { token: string; children: ReactNode }) {
  return <CsrfContext.Provider value={token}>{children}</CsrfContext.Provider>;
}

export function useCsrfToken(): string | null {
  return useContext(CsrfContext);
}
