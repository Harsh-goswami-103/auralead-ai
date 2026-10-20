'use client';

/**
 * Mirrors the panel key onto <body> (design spec §1, panel signatures). Dialogs, sheets, menus,
 * the command palette and toasts are portaled to the end of <body>, outside PanelShell's
 * [data-panel] root. With body[data-panel] they read the same --panel-hue and --panel-grad as the
 * page (tokens.css selects [data-panel] anywhere). The attribute is removed on unmount, so
 * /login and the 404 page fall back to the :root aurora defaults. Renders nothing.
 */
import { useEffect } from 'react';
import type { PanelKey } from './panel-nav';

export function PanelSignature({ panel }: { panel: PanelKey }) {
  useEffect(() => {
    const body = document.body;
    body.dataset.panel = panel;
    return () => {
      if (body.dataset.panel === panel) delete body.dataset.panel;
    };
  }, [panel]);
  return null;
}
