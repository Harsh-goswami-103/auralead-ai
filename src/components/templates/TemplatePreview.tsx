/**
 * Live WhatsApp preview of a template (ADR-123, slice F4): the message as the customer sees it, on
 * the chat wallpaper in an incoming bubble (the `--chat-*` tokens, ADR-121; text-1 and the meta
 * and accent colors are contrast-tested on that bubble). Header (text, or the PDF document chip),
 * body with each `{{n}}` shown as its example value (underlined, with the variable and its source
 * in the title) or as the raw `{{n}}` when no example is given, footer, and the buttons below the
 * bubble. Plain text only (no markup is interpreted). Server-safe, no hooks.
 */
import { ExternalLink, FileText, Phone, Reply } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { alignedVariables, orderedButtons, type TemplateDraft } from '@/lib/domain/template-authoring';
import { TEMPLATE_VARIABLE_SOURCES } from '@/lib/domain/whatsapp-templates';

type Piece = { text: string; variable: string | null };

function pieces(text: string, examples: ReadonlyMap<string, { example: string; source: string }>): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), variable: null });
    out.push({ text: m[0], variable: String(Number(m[1])) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), variable: null });
  return out.map((p) => (p.variable === null ? p : { text: examples.get(p.variable)?.example || `{{${p.variable}}}`, variable: p.variable }));
}

function Rendered({ text, examples }: { text: string; examples: ReadonlyMap<string, { example: string; source: string }> }) {
  return (
    <>
      {pieces(text, examples).map((p, i) =>
        p.variable === null ? (
          <span key={i}>{p.text}</span>
        ) : (
          <span
            key={i}
            data-preview-variable={p.variable}
            title={`{{${p.variable}}}: ${TEMPLATE_VARIABLE_SOURCES[examples.get(p.variable)?.source as keyof typeof TEMPLATE_VARIABLE_SOURCES] ?? 'Typed by the person sending'}`}
            className={cn('underline decoration-dotted underline-offset-2', examples.get(p.variable)?.example ? '' : 'font-mono text-chat-meta')}
          >
            {p.text}
          </span>
        ),
      )}
    </>
  );
}

export function TemplatePreview({ draft, documentName, businessName, className }: { draft: TemplateDraft; documentName?: string | null; businessName: string; className?: string }) {
  const examples = new Map(alignedVariables(draft).map((v) => [v.position, { example: v.example, source: v.source }]));
  const headerExamples = new Map(draft.header.format === 'TEXT' && draft.header.example ? [['1', { example: draft.header.example, source: 'manual' }]] : []);
  const buttons = orderedButtons(draft.buttons);
  const empty = draft.body.trim() === '';
  return (
    <figure aria-label="WhatsApp preview" className={cn('flex min-w-0 flex-col gap-2 rounded-xl bg-chat-wallpaper p-3 sm:p-4', className)}>
      <figcaption className="text-xs text-chat-meta">Preview: {businessName} on WhatsApp</figcaption>
      <div className="flex max-w-[22rem] flex-col gap-1">
        <div data-preview-bubble className="flex flex-col gap-1.5 rounded-lg rounded-tl-none bg-chat-bubble-in px-3 py-2 text-sm text-fg-1 shadow-sm">
          {draft.header.format === 'TEXT' && draft.header.text.trim() !== '' ? (
            <p data-preview-header className="font-semibold break-words">
              <Rendered text={draft.header.text} examples={headerExamples} />
            </p>
          ) : null}
          {draft.header.format === 'DOCUMENT' ? (
            <p data-preview-header className="flex items-center gap-2 rounded-md bg-chat-wallpaper/60 px-2 py-2 text-xs">
              <FileText aria-hidden="true" className="size-5 shrink-0 text-chat-meta" />
              <span className="truncate">{documentName ?? 'PDF brochure (choose one)'}</span>
            </p>
          ) : null}
          <p data-preview-body className={cn('break-words whitespace-pre-wrap', empty && 'text-chat-meta')}>
            {empty ? 'Your message appears here.' : <Rendered text={draft.body} examples={examples} />}
          </p>
          {draft.footer && draft.footer.trim() !== '' ? <p data-preview-footer className="text-xs text-chat-meta">{draft.footer}</p> : null}
        </div>
        {buttons.map((b, i) => {
          const Icon = b.type === 'URL' ? ExternalLink : b.type === 'PHONE_NUMBER' ? Phone : Reply;
          return (
            <span key={i} data-preview-button={b.type} className="flex items-center justify-center gap-1.5 rounded-lg bg-chat-bubble-in px-3 py-2 text-sm font-medium text-chat-accent">
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              {b.text.trim() === '' ? 'Button text' : b.text}
            </span>
          );
        })}
      </div>
    </figure>
  );
}
