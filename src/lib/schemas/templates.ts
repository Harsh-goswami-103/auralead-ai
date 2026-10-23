/**
 * Template studio request bodies (ADR-123, slice F4), shared by the `/api/app/templates/**`
 * routes, the studio service and the form. Shape only: the template rules (Meta's limits, the
 * category rules, examples before submission) are `checkTemplateDraft` in
 * src/lib/domain/template-authoring.ts, which the service runs and the form shows. Strings are capped
 * generously here so an over-long value reaches that check and gets its own message.
 */
import { z } from 'zod';
import { HEADER_FORMATS, STUDIO_CATEGORIES, UTILITY_TRIGGERS, type TemplateDraft } from '@/lib/domain/template-authoring';
import { QUICK_REPLY_INTENT_VALUES, TEMPLATE_VARIABLE_SOURCES, type TemplateVariableSource } from '@/lib/domain/whatsapp-templates';
import { workspaceSlugField } from './lead-console';

const SOURCE_KEYS = Object.keys(TEMPLATE_VARIABLE_SOURCES) as [TemplateVariableSource, ...TemplateVariableSource[]];

/** Who wrote the copy, when the person kept generated copy (provenance only; anthropic, openai or the local generator). */
export const COPY_GENERATOR_LABELS = ['anthropic', 'openai', 'local-deterministic'] as const;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const header = z.discriminatedUnion('format', [
  z.object({ format: z.literal(HEADER_FORMATS[0]) }),
  z.object({ format: z.literal(HEADER_FORMATS[1]), text: z.string().max(400), example: z.string().max(1000).nullable().default(null) }),
  z.object({ format: z.literal(HEADER_FORMATS[2]), mediaId: id.nullable().default(null) }),
]);

const button = z.discriminatedUnion('type', [
  z.object({ type: z.literal('QUICK_REPLY'), text: z.string().max(200), intent: z.enum(QUICK_REPLY_INTENT_VALUES).nullable().default(null) }),
  z.object({ type: z.literal('URL'), text: z.string().max(200), url: z.string().max(4000) }),
  z.object({ type: z.literal('PHONE_NUMBER'), text: z.string().max(200), phoneNumber: z.string().max(64) }),
]);

/** The fields of a draft (create and save). */
export const TemplateDraftFields = z.object({
  category: z.enum(STUDIO_CATEGORIES),
  language: z.string().trim().min(1).max(16),
  name: z.string().trim().max(1000),
  utilityTrigger: z.enum(UTILITY_TRIGGERS).nullable().default(null),
  header: header.default({ format: 'NONE' }),
  body: z.string().max(4000),
  variables: z
    .array(z.object({ position: z.string().regex(/^[1-9]\d?$/), source: z.enum(SOURCE_KEYS).default('manual'), example: z.string().max(1000).default('') }))
    .max(20)
    .default([]),
  footer: z.string().max(400).nullable().default(null),
  buttons: z.array(button).max(10).default([]),
  /** Set when the person kept copy from "Generate with AI" (or the local template). */
  copyGeneratorLabel: z.enum(COPY_GENERATOR_LABELS).nullable().default(null),
});
export type TemplateDraftFields = z.output<typeof TemplateDraftFields>;

export const TemplateDraftBody = TemplateDraftFields.extend({ workspaceSlug: workspaceSlugField.optional() });
export type TemplateDraftBody = z.output<typeof TemplateDraftBody>;

/** Submit and delete: the template comes from the URL, the workspace from the slug. */
export const TemplateActionBody = z.object({ workspaceSlug: workspaceSlugField.optional() });
export type TemplateActionBody = z.output<typeof TemplateActionBody>;

/** "Generate with AI": the category the person chose (the model cannot change it) and what the template is for. */
export const TemplateCopyBody = z.object({
  workspaceSlug: workspaceSlugField.optional(),
  category: z.enum(STUDIO_CATEGORIES),
  language: z.string().trim().min(1).max(16).default('en'),
  utilityTrigger: z.enum(UTILITY_TRIGGERS).nullable().default(null),
  purpose: z.string().trim().max(300).default(''),
  /** Ask for the local template generator explicitly (LIVE without an AI integration, or by choice). */
  local: z.boolean().default(false),
});
export type TemplateCopyBody = z.output<typeof TemplateCopyBody>;

/** The draft part of a body (everything but the workspace and the provenance). */
export function draftOf(fields: TemplateDraftFields): TemplateDraft {
  return {
    category: fields.category,
    language: fields.language,
    name: fields.name.trim(),
    utilityTrigger: fields.utilityTrigger,
    header: fields.header,
    body: fields.body,
    variables: fields.variables,
    footer: fields.footer,
    buttons: fields.buttons,
  };
}

// ---- Media library (PDF brochures for document headers, ADR-123) ---------------------------------

/** The largest PDF brochure a workspace may upload (5 MB). */
export const MEDIA_PDF_MAX_BYTES = 5 * 1024 * 1024;

/** The upload body: base64 in JSON, like the logo upload (plan: mutations are JSON only). */
export const MediaUploadBody = z.object({
  workspaceSlug: workspaceSlugField.optional(),
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().max(100),
  dataBase64: z.string().min(1),
});
export type MediaUploadBody = z.output<typeof MediaUploadBody>;

/** The JSON body cap of the upload route: base64 of 5 MB plus the envelope. A larger body is 413. */
export const MEDIA_UPLOAD_MAX_BODY_BYTES = Math.ceil(MEDIA_PDF_MAX_BYTES / 3) * 4 + 64 * 1024;
