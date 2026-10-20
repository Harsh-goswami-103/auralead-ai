/**
 * Renders one docs content string (content/docs/format.ts): `code`, **bold** and [label](href) become
 * real elements, everything else is text. React escapes every string, and no HTML is ever injected.
 * Each href goes through safeHref first: a refused one (javascript:, data:, a protocol-relative URL)
 * renders its label as plain text, never as a link. Same-origin paths use next/link; external
 * links get rel="noreferrer". Server-safe.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { parseInline, type InlineNode } from '@content/docs/format';
import { safeHref } from '@/server/security/safe-href';

const LINK_CLASS = 'font-medium text-aura underline decoration-aura/40 underline-offset-4 hover:decoration-aura';
export const CODE_SPAN_CLASS = 'rounded-sm border border-border-subtle bg-bg-3/70 px-1 py-px font-mono text-[0.85em] text-fg-1 [overflow-wrap:anywhere]';

function renderNodes(nodes: readonly InlineNode[], prefix: string): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${prefix}${i}`;
    switch (node.type) {
      case 'text':
        return node.value;
      case 'code':
        return (
          <code key={key} className={CODE_SPAN_CLASS}>
            {node.value}
          </code>
        );
      case 'strong':
        return (
          <strong key={key} className="font-semibold text-fg-1">
            {renderNodes(node.children, `${key}.`)}
          </strong>
        );
      case 'link': {
        const children = renderNodes(node.children, `${key}.`);
        const href = safeHref(node.href);
        if (href === null) return <span key={key}>{children}</span>;
        if (href.startsWith('/'))
          return (
            <Link key={key} href={href} className={LINK_CLASS}>
              {children}
            </Link>
          );
        if (href.startsWith('#'))
          return (
            <a key={key} href={href} className={LINK_CLASS}>
              {children}
            </a>
          );
        return (
          <a key={key} href={href} rel="noreferrer" className={LINK_CLASS}>
            {children}
          </a>
        );
      }
    }
  });
}

export function Inline({ text }: { text: string }) {
  return <>{renderNodes(parseInline(text), 'i')}</>;
}
