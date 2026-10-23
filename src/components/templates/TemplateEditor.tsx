'use client';

/**
 * The template studio form (ADR-123, slice F4). The person chooses the category first (Marketing
 * or Utility, with what each one is for); the rest of the form appears once it is chosen:
 * language and name, "Generate with AI" (the category goes to the model, which cannot change it;
 * DEMO runs the labelled local template), the header (none, text, or a PDF brochure from the media
 * library, uploaded here: POST /api/app/media, 5 MB), the body with one button per
 * lead or business fact that inserts the next `{{n}}` and maps it, a source and an example for
 * every variable, the footer and the buttons (quick replies, website links, a call button; a
 * Marketing template starts with the Stop quick reply, mapped to the STOP payload). Utility
 * templates say when they are sent. The checks shown are the server's own
 * (`checkTemplateDraft`), live: problems to fix before submitting, and warnings that never block.
 * "Save draft" posts to /api/app/templates (new) or /api/app/templates/[id]; the live WhatsApp
 * preview follows every keystroke. Submission happens from the template list.
 */
import { useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, CircleCheck, Plus, Save, Trash2, TriangleAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { AiActionButton } from '@/components/ai/AiActionButton';
import { AiProvenance } from '@/components/ai/AiProvenance';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import type { Gate } from '@/components/patterns/GatedAction';
import { SectionCard } from '@/components/patterns/SectionCard';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import {
  checkTemplateDraft,
  emptyDraft,
  positionalVariables,
  STUDIO_CATEGORIES,
  STUDIO_CATEGORY_LABELS,
  TEMPLATE_LANGUAGES,
  TEMPLATE_LIMITS,
  UTILITY_TRIGGER_LABELS,
  UTILITY_TRIGGERS,
  withCategory,
  type DraftButton,
  type DraftIssue,
  type StudioCategory,
  type TemplateDraft,
  type UtilityTrigger,
} from '@/lib/domain/template-authoring';
import { QUICK_REPLY_INTENT_LABELS, QUICK_REPLY_INTENT_VALUES, type QuickReplyIntentValue, type TemplateVariableSource } from '@/lib/domain/whatsapp-templates';
import { BUTTON_TYPE_LABELS, HEADER_FORMAT_LABELS, INSERTABLE_SOURCES, SOURCE_OPTIONS } from './template-vocabulary';
import { TemplatePreview } from './TemplatePreview';

export type EditorInitial = { id: string | null; draft: TemplateDraft | null; copyGeneratorLabel: string | null };

export type MediaOption = { id: string; fileName: string; byteSize: number };

export type TemplateEditorProps = {
  workspaceSlug: string;
  businessName: string;
  /** DEMO runs the labelled local generator (never presented as AI). */
  localGenerator: boolean;
  /** Generate is blocked (LIVE without an AI integration): the configuration gate. */
  aiGate: Gate | null;
  initial: EditorInitial;
  /** The workspace's PDF brochures (document headers). */
  media: MediaOption[];
  onClose: () => void;
  /** Called after a successful save with the stored template id. */
  onSaved?: (templateId: string) => void;
};

type SaveResponse = { template: { id: string; name: string }; warnings: DraftIssue[] };
type GenerateResponse = { draft: TemplateDraft; generatorLabel: string; modelId: string; warnings: DraftIssue[] };

const HEADER_FORMATS_OFFERED = ['NONE', 'TEXT', 'DOCUMENT'] as const;
const MAX_PDF_BYTES = 5 * 1024 * 1024;

/** The file as base64 (the upload route takes JSON). */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });
}

function documentNameOf(draft: TemplateDraft, library: readonly MediaOption[]): string | null {
  const header = draft.header;
  return header.format === 'DOCUMENT' ? (library.find((m) => m.id === header.mediaId)?.fileName ?? null) : null;
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function TemplateEditor(props: TemplateEditorProps) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const id = useId();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [templateId, setTemplateId] = useState<string | null>(props.initial.id);
  const [draft, setDraft] = useState<TemplateDraft | null>(props.initial.draft);
  const [generator, setGenerator] = useState<{ label: string; modelId: string | null } | null>(props.initial.copyGeneratorLabel ? { label: props.initial.copyGeneratorLabel, modelId: null } : null);
  const [purpose, setPurpose] = useState('');
  const [line, setLine] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [library, setLibrary] = useState<MediaOption[]>(props.media);
  const [uploading, setUploading] = useState(false);

  const check = useMemo(() => (draft ? checkTemplateDraft(draft, { forSubmit: true }) : null), [draft]);
  const update = (patch: Partial<TemplateDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  function chooseCategory(category: StudioCategory) {
    setDraft((d) => (d ? withCategory(d, category) : emptyDraft(category)));
  }

  function setBody(body: string) {
    setDraft((d) => (d ? { ...d, body } : d));
  }

  function insertVariable(source: TemplateVariableSource) {
    if (!draft) return;
    const position = String(positionalVariables(draft.body).length + 1);
    const token = `{{${position}}}`;
    const el = bodyRef.current;
    const start = el?.selectionStart ?? draft.body.length;
    const end = el?.selectionEnd ?? draft.body.length;
    const before = draft.body.slice(0, start);
    const after = draft.body.slice(end);
    const spacedBefore = before === '' || /\s$/.test(before) ? before : `${before} `;
    const spacedAfter = after === '' || /^[\s.,!?]/.test(after) ? after : ` ${after}`;
    const body = `${spacedBefore}${token}${spacedAfter}`;
    const example = source === 'workspace.name' ? props.businessName : '';
    update({ body, variables: [...draft.variables.filter((v) => v.position !== position), { position, source, example }] });
    requestAnimationFrame(() => {
      const caret = spacedBefore.length + token.length;
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  function setVariable(position: string, patch: { source?: TemplateVariableSource; example?: string }) {
    if (!draft) return;
    const existing = draft.variables.find((v) => v.position === position) ?? { position, source: 'manual' as TemplateVariableSource, example: '' };
    update({ variables: [...draft.variables.filter((v) => v.position !== position), { ...existing, ...patch }] });
  }

  function setButton(index: number, next: DraftButton) {
    if (!draft) return;
    update({ buttons: draft.buttons.map((b, i) => (i === index ? next : b)) });
  }

  function addButton(type: DraftButton['type']) {
    if (!draft) return;
    const b: DraftButton = type === 'QUICK_REPLY' ? { type, text: '', intent: null } : type === 'URL' ? { type, text: '', url: 'https://' } : { type, text: '', phoneNumber: '+91' };
    update({ buttons: [...draft.buttons, b] });
  }

  async function generate() {
    if (!draft) return;
    setLine(null);
    const res = await postJson<GenerateResponse>(
      '/api/app/templates/generate',
      { workspaceSlug: props.workspaceSlug, category: draft.category, language: draft.language, utilityTrigger: draft.utilityTrigger, purpose, local: props.localGenerator },
      csrf,
    );
    if (!res.ok) {
      setLine({ ok: false, text: `${res.message}${res.reference ? ` Reference ${res.reference}.` : ''}` });
      return;
    }
    setDraft({ ...res.data.draft, category: draft.category, language: draft.language, utilityTrigger: draft.utilityTrigger });
    setGenerator({ label: res.data.generatorLabel, modelId: res.data.modelId });
    setLine({ ok: true, text: 'Copy generated. Review every line before you save: you are responsible for what is sent.' });
  }

  async function upload(file: File | null, input: HTMLInputElement) {
    if (!file || uploading) return;
    setLine(null);
    if (file.size > MAX_PDF_BYTES) {
      setLine({ ok: false, text: 'The PDF is larger than 5 MB. Export a smaller file.' });
      input.value = '';
      return;
    }
    setUploading(true);
    try {
      const dataBase64 = await readAsBase64(file);
      const res = await postJson<{ asset: MediaOption }>('/api/app/media', { workspaceSlug: props.workspaceSlug, fileName: file.name, contentType: file.type || 'application/pdf', dataBase64 }, csrf);
      if (!res.ok) {
        setLine({ ok: false, text: `${res.message}${res.reference ? ` Reference ${res.reference}.` : ''}` });
        return;
      }
      const asset = res.data.asset;
      setLibrary((l) => [asset, ...l.filter((m) => m.id !== asset.id)]);
      update({ header: { format: 'DOCUMENT', mediaId: asset.id } });
      setLine({ ok: true, text: `${asset.fileName} uploaded and chosen for the header.` });
    } catch {
      setLine({ ok: false, text: 'The file could not be read. Choose the PDF again.' });
    } finally {
      input.value = '';
      setUploading(false);
    }
  }

  async function save() {
    if (!draft || saving) return;
    setSaving(true);
    setLine(null);
    try {
      const url = templateId ? `/api/app/templates/${encodeURIComponent(templateId)}` : '/api/app/templates';
      const res = await postJson<SaveResponse>(url, { workspaceSlug: props.workspaceSlug, ...draft, copyGeneratorLabel: generator?.label ?? null }, csrf);
      if (!res.ok) {
        setLine({ ok: false, text: `${res.message}${res.reference ? ` Reference ${res.reference}.` : ''}` });
        return;
      }
      setTemplateId(res.data.template.id);
      setLine({ ok: true, text: 'Draft saved. Submit it for approval from the template list when it is ready.' });
      toast.success('Draft saved', { description: res.data.template.name });
      props.onSaved?.(res.data.template.id);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const positions = draft ? positionalVariables(draft.body) : [];
  const quickCount = draft?.buttons.filter((b) => b.type === 'QUICK_REPLY').length ?? 0;
  const urlCount = draft?.buttons.filter((b) => b.type === 'URL').length ?? 0;
  const phoneCount = draft?.buttons.filter((b) => b.type === 'PHONE_NUMBER').length ?? 0;

  return (
    <SectionCard
      title={templateId ? 'Edit template draft' : 'New template'}
      meta="Meta reviews every template before it can be sent. Approval usually takes minutes, sometimes a day."
      actions={
        <Button variant="ghost" size="sm" onClick={props.onClose}>
          <X aria-hidden="true" />
          Close
        </Button>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-5">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-fg-1">1. Category (choose first)</legend>
            <div role="radiogroup" aria-label="Category" className="grid gap-2 sm:grid-cols-2">
              {STUDIO_CATEGORIES.map((c) => (
                <div key={c} className={cn('flex flex-col gap-1 rounded-lg border p-3 text-sm', draft?.category === c ? 'border-panel/60 bg-panel/10' : 'border-border-subtle bg-bg-2/50 hover:bg-bg-3')}>
                  <label className="flex cursor-pointer items-center gap-2 font-medium text-fg-1">
                    <input type="radio" name={`${id}-category`} value={c} checked={draft?.category === c} onChange={() => chooseCategory(c)} aria-describedby={`${id}-category-${c}`} className="accent-current" />
                    {STUDIO_CATEGORY_LABELS[c].label}
                  </label>
                  <span id={`${id}-category-${c}`} className="text-xs text-fg-2">
                    {STUDIO_CATEGORY_LABELS[c].hint}
                  </span>
                </div>
              ))}
            </div>
            {draft?.category === 'UTILITY' ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-trigger`} className="text-fg-1">
                  Sent when
                </Label>
                <NativeSelect id={`${id}-trigger`} value={draft.utilityTrigger ?? ''} onChange={(e) => update({ utilityTrigger: e.target.value === '' ? null : (e.target.value as UtilityTrigger) })}>
                  <option value="">Choose when it is sent</option>
                  {UTILITY_TRIGGERS.map((t) => (
                    <option key={t} value={t}>
                      {UTILITY_TRIGGER_LABELS[t]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
          </fieldset>

          {draft === null ? (
            <p className="text-sm text-fg-2">Choose a category to start. It decides the rules your template is reviewed against.</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-language`} className="text-fg-1">
                    Language
                  </Label>
                  <NativeSelect id={`${id}-language`} value={draft.language} onChange={(e) => update({ language: e.target.value })}>
                    {TEMPLATE_LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.label} ({l.code})
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-name`} className="text-fg-1">
                    Name
                  </Label>
                  <Input id={`${id}-name`} value={draft.name} maxLength={TEMPLATE_LIMITS.name} placeholder="website_intro" className="font-mono" onChange={(e) => update({ name: e.target.value })} />
                  <span className="text-xs text-fg-2">Lowercase letters, digits and underscores. WhatsApp Manager shows this name.</span>
                </div>
              </div>

              <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-bg-2/40 p-3">
                <Label htmlFor={`${id}-purpose`} className="text-fg-1">
                  What is this template for? (optional, for the generator)
                </Label>
                <Input id={`${id}-purpose`} value={purpose} maxLength={300} placeholder="Introduce our website design service to businesses without a website" onChange={(e) => setPurpose(e.target.value)} />
                <div className="flex flex-wrap items-center gap-2">
                  <AiActionButton onAction={generate} local={props.localGenerator} gate={props.aiGate} size="sm" />
                  {generator ? <AiProvenance generatorLabel={generator.label} modelId={generator.modelId} /> : null}
                </div>
              </div>

              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium text-fg-1">Header</legend>
                <div role="radiogroup" aria-label="Header" className="flex flex-wrap gap-2">
                  {HEADER_FORMATS_OFFERED.map((f) => (
                    <label key={f} className={cn('flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm', draft.header.format === f ? 'border-panel/60 bg-panel/10 text-fg-1' : 'border-border-subtle text-fg-2 hover:bg-bg-3')}>
                      <input
                        type="radio"
                        name={`${id}-header`}
                        value={f}
                        checked={draft.header.format === f}
                        onChange={() =>
                          update({
                            header:
                              f === 'TEXT'
                                ? { format: 'TEXT', text: draft.header.format === 'TEXT' ? draft.header.text : '', example: null }
                                : f === 'DOCUMENT'
                                  ? { format: 'DOCUMENT', mediaId: draft.header.format === 'DOCUMENT' ? draft.header.mediaId : (library[0]?.id ?? null) }
                                  : { format: 'NONE' },
                          })
                        }
                        className="accent-current"
                      />
                      {HEADER_FORMAT_LABELS[f]}
                    </label>
                  ))}
                </div>
                {draft.header.format === 'DOCUMENT' ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${id}-header-media`} className="text-fg-1">
                        Brochure (PDF)
                      </Label>
                      <NativeSelect id={`${id}-header-media`} value={draft.header.mediaId ?? ''} onChange={(e) => update({ header: { format: 'DOCUMENT', mediaId: e.target.value === '' ? null : e.target.value } })}>
                        <option value="">Choose a brochure</option>
                        {library.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.fileName} ({sizeLabel(m.byteSize)})
                          </option>
                        ))}
                      </NativeSelect>
                      <span className="text-xs text-fg-2">Sent as the header document of every message of this template. A brochure is a Marketing template.</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${id}-header-upload`} className="text-fg-1">
                        Upload a PDF (up to 5 MB)
                      </Label>
                      <Input id={`${id}-header-upload`} type="file" accept="application/pdf,.pdf" aria-busy={uploading || undefined} onChange={(e) => void upload(e.target.files?.[0] ?? null, e.target)} />
                    </div>
                  </div>
                ) : null}
                {draft.header.format === 'TEXT' ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${id}-header-text`} className="text-fg-1">
                        Header text
                      </Label>
                      <Input id={`${id}-header-text`} value={draft.header.text} maxLength={TEMPLATE_LIMITS.headerText} onChange={(e) => update({ header: { format: 'TEXT', text: e.target.value, example: draft.header.format === 'TEXT' ? draft.header.example : null } })} />
                      <span className="text-xs text-fg-2">
                        {draft.header.text.length}/{TEMPLATE_LIMITS.headerText}
                      </span>
                    </div>
                    {/\{\{\s*1\s*\}\}/.test(draft.header.text) ? (
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor={`${id}-header-example`} className="text-fg-1">
                          Example for the header {'{{1}}'}
                        </Label>
                        <Input id={`${id}-header-example`} value={draft.header.example ?? ''} onChange={(e) => update({ header: { format: 'TEXT', text: draft.header.format === 'TEXT' ? draft.header.text : '', example: e.target.value } })} />
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </fieldset>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-body`} className="text-fg-1">
                  Message body
                </Label>
                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Insert a variable">
                  <span className="text-xs text-fg-2">Insert:</span>
                  {INSERTABLE_SOURCES.map((s) => (
                    <Button key={s.source} type="button" variant="secondary" size="xs" onClick={() => insertVariable(s.source)}>
                      <Plus aria-hidden="true" />
                      {s.label}
                    </Button>
                  ))}
                </div>
                <Textarea id={`${id}-body`} ref={bodyRef} rows={6} value={draft.body} onChange={(e) => setBody(e.target.value)} placeholder="Hello {{1}}, ..." />
                <span className="text-xs text-fg-2">
                  {draft.body.length}/{TEMPLATE_LIMITS.body}. Each {'{{n}}'} is filled for every lead when it is sent.
                </span>
              </div>

              {positions.length > 0 ? (
                <div className="relative overflow-x-auto rounded-lg border border-border-subtle">
                  <table className="w-full min-w-[30rem] text-left text-sm">
                    <caption className="sr-only">Variables, what fills them and their example values</caption>
                    <thead className="bg-bg-2/60 text-xs text-fg-2">
                      <tr>
                        <th scope="col" className="px-3 py-2 font-medium">
                          Variable
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          Filled with
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          Example for Meta’s review
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {positions.map((p) => {
                        const v = draft.variables.find((x) => x.position === p);
                        return (
                          <tr key={p} data-variable-row={p} className="border-t border-border-subtle">
                            <th scope="row" className="px-3 py-2 font-mono font-normal text-fg-1">{`{{${p}}}`}</th>
                            <td className="px-3 py-2">
                              <NativeSelect aria-label={`What fills {{${p}}}`} value={v?.source ?? 'manual'} onChange={(e) => setVariable(p, { source: e.target.value as TemplateVariableSource })}>
                                {SOURCE_OPTIONS.map((o) => (
                                  <option key={o.source} value={o.source}>
                                    {o.label}
                                  </option>
                                ))}
                              </NativeSelect>
                            </td>
                            <td className="px-3 py-2">
                              <Input aria-label={`Example for {{${p}}}`} value={v?.example ?? ''} maxLength={TEMPLATE_LIMITS.example} onChange={(e) => setVariable(p, { example: e.target.value })} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-footer`} className="text-fg-1">
                  Footer (optional)
                </Label>
                <Input id={`${id}-footer`} value={draft.footer ?? ''} maxLength={TEMPLATE_LIMITS.footer} onChange={(e) => update({ footer: e.target.value === '' ? null : e.target.value })} />
              </div>

              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium text-fg-1">Buttons</legend>
                {draft.buttons.length === 0 ? <p className="text-xs text-fg-2">No buttons.</p> : null}
                <ul className="flex flex-col gap-2">
                  {draft.buttons.map((b, i) => (
                    <li key={i} data-button-row={b.type} className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-bg-2/40 p-2 sm:flex-row sm:items-end">
                      <span className="text-xs font-medium text-fg-2 sm:w-24 sm:pb-2">{BUTTON_TYPE_LABELS[b.type]}</span>
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <Label htmlFor={`${id}-btn-${i}`} className="text-xs text-fg-2">
                          Button text
                        </Label>
                        <Input id={`${id}-btn-${i}`} value={b.text} maxLength={TEMPLATE_LIMITS.buttonText} onChange={(e) => setButton(i, { ...b, text: e.target.value })} />
                      </div>
                      {b.type === 'QUICK_REPLY' ? (
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <Label htmlFor={`${id}-btn-${i}-intent`} className="text-xs text-fg-2">
                            When tapped
                          </Label>
                          <NativeSelect id={`${id}-btn-${i}-intent`} value={b.intent ?? ''} onChange={(e) => setButton(i, { ...b, intent: e.target.value === '' ? null : (e.target.value as QuickReplyIntentValue) })}>
                            <option value="">No action (a reply)</option>
                            {QUICK_REPLY_INTENT_VALUES.map((intent) => (
                              <option key={intent} value={intent}>
                                {QUICK_REPLY_INTENT_LABELS[intent]}
                              </option>
                            ))}
                          </NativeSelect>
                        </div>
                      ) : b.type === 'URL' ? (
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <Label htmlFor={`${id}-btn-${i}-url`} className="text-xs text-fg-2">
                            Link (https)
                          </Label>
                          <Input id={`${id}-btn-${i}-url`} value={b.url} onChange={(e) => setButton(i, { ...b, url: e.target.value })} />
                        </div>
                      ) : (
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <Label htmlFor={`${id}-btn-${i}-phone`} className="text-xs text-fg-2">
                            Phone number
                          </Label>
                          <Input id={`${id}-btn-${i}-phone`} value={b.phoneNumber} onChange={(e) => setButton(i, { ...b, phoneNumber: e.target.value })} />
                        </div>
                      )}
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove button ${b.text || i + 1}`} onClick={() => update({ buttons: draft.buttons.filter((_, j) => j !== i) })}>
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  {quickCount < TEMPLATE_LIMITS.quickReplies ? (
                    <Button type="button" variant="secondary" size="sm" onClick={() => addButton('QUICK_REPLY')}>
                      <Plus aria-hidden="true" />
                      Add quick reply
                    </Button>
                  ) : null}
                  {urlCount < TEMPLATE_LIMITS.urlButtons ? (
                    <Button type="button" variant="secondary" size="sm" onClick={() => addButton('URL')}>
                      <Plus aria-hidden="true" />
                      Add website link
                    </Button>
                  ) : null}
                  {phoneCount < TEMPLATE_LIMITS.phoneButtons ? (
                    <Button type="button" variant="secondary" size="sm" onClick={() => addButton('PHONE_NUMBER')}>
                      <Plus aria-hidden="true" />
                      Add call button
                    </Button>
                  ) : null}
                </div>
              </fieldset>

              {check && (check.errors.length > 0 || check.warnings.length > 0) ? (
                <div className="flex flex-col gap-2" data-template-checks>
                  {check.errors.length > 0 ? (
                    <div className="rounded-lg border border-danger/30 bg-danger/8 px-3 py-2">
                      <p className="flex items-center gap-1.5 text-sm font-medium text-fg-1">
                        <CircleAlert aria-hidden="true" className="size-4 text-danger" />
                        To fix before submitting
                      </p>
                      <ul className="mt-1 list-disc pl-5 text-xs text-fg-1">
                        {check.errors.map((e) => (
                          <li key={`${e.field}-${e.code}`} data-issue={e.code}>
                            {e.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {check.warnings.length > 0 ? (
                    <div className="rounded-lg border border-warning/35 bg-warning/8 px-3 py-2">
                      <p className="flex items-center gap-1.5 text-sm font-medium text-fg-1">
                        <TriangleAlert aria-hidden="true" className="size-4 text-warning" />
                        Worth a look
                      </p>
                      <ul className="mt-1 list-disc pl-5 text-xs text-fg-1">
                        {check.warnings.map((w) => (
                          <li key={`${w.field}-${w.code}`} data-warning={w.code}>
                            {w.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" onClick={() => void save()} aria-busy={saving || undefined}>
                  <Save aria-hidden="true" />
                  {saving ? 'Saving...' : 'Save draft'}
                </Button>
                <Button type="button" variant="ghost" onClick={props.onClose}>
                  Cancel
                </Button>
              </div>
            </>
          )}
          {line ? (
            <p role={line.ok ? 'status' : 'alert'} className="flex items-start gap-1.5 text-sm text-fg-1">
              {line.ok ? <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />}
              {line.text}
            </p>
          ) : null}
        </div>
        <div className="min-w-0">
          {draft ? (
            <TemplatePreview
              draft={draft}
              businessName={props.businessName}
              documentName={documentNameOf(draft, library)}
              className="lg:sticky lg:top-4"
            />
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}
