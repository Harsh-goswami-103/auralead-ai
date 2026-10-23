/**
 * Plain-language names for the audit actions the services write, for the command-center activity
 * feed (06-design §11.1 "activity feed (from AuditEvent)"; user report "raw audit codes"). Every
 * action AuraLead emits has a sentence here; an unknown one still reads as words (never a dotted
 * code). Families pick the row icon. Pure data, shared by server and client components.
 */
import { FileText, History, MessagesSquare, Palette, Send, ShieldAlert, ShieldCheck, Sparkles, Tags, UserRound, Webhook, Workflow, type LucideIcon } from 'lucide-react';

export const ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  'quote.create': 'Quotation created',
  'quote.revise': 'Quotation revised (new version)',
  'quote.approve': 'Quotation approved',
  'quote.cancel': 'Quotation cancelled',
  'quote.expire': 'Quotation expired',
  'quote.share.create': 'Share link created',
  'quote.share.revoke': 'Share link revoked',
  'quote.send': 'Quotation sent',
  'quote.sent': 'Quotation sent',
  'quote.view': 'Quotation opened (may be automated)',
  'quote.view.unsent': 'A link was opened before it was marked as sent',
  'quote.accept': 'Quotation accepted',
  'quote.pdf.render': 'Quotation PDF ready',
  'quote.sent_superseded_version': 'An older quotation version was sent',
  'lead.ingest': 'Lead received',
  'lead.score': 'Lead scored',
  'lead.enrich': 'Website checked',
  'lead.merge_review.open': 'Possible duplicate sent to review',
  'lead.erase': 'Lead data erased',
  'import.batch.ingest': 'Import batch processed',
  'ai.draft.request': 'Draft requested',
  'ai.draft.generate': 'Draft prepared',
  'ai.proposal.flagged': 'Draft flagged for review',
  'message.send': 'Message queued to send',
  'message.draft': 'Message saved for review',
  'message.status': 'Delivery status updated',
  'dispatch.queue': 'Send queued',
  'dispatch.sent': 'Message sent',
  'dispatch.failed': 'Send failed',
  'dispatch.ambiguous': 'Delivery unknown after a timeout',
  'dispatch.ambiguous_resolved': 'Unknown delivery resolved',
  'dispatch.operator_resolve': 'Delivery resolved by an operator',
  'dispatch.cancelled': 'Send cancelled',
  'dispatch.skipped': 'Send skipped by the delivery checks',
  'approval.reject': 'Item rejected',
  'conversation.takeover': 'A person took over a conversation',
  'conversation.resume': 'Automated replies resumed',
  'conversation.ai_mode': 'Conversation AI mode changed',
  'conversation.escalated': 'Conversation handed to a person',
  'reply.drafted': 'Suggested reply drafted',
  'reply.superseded': 'Suggested reply replaced',
  'consent.grant': 'Consent recorded',
  'consent.capture': 'Consent captured from a form',
  'suppression.stop': 'Contact opted out',
  'suppression.stop_repeat': 'Repeat opt-out recorded',
  'suppression.clear': 'Opt-out cleared by newer consent',
  'suppression.clear_refused': 'Opt-out kept (consent was older)',
  'suppression.replay': 'Opt-out restored after a backup restore',
  'quick_reply.quote_requested': 'Customer asked for a quotation',
  'quick_reply.review': 'Quick reply needs review',
  'call_request.create': 'Customer asked for a call',
  'pricing.service.create': 'Service added',
  'pricing.service.update': 'Service updated',
  'pricing.service.archive': 'Service archived',
  'pricing.service.delete': 'Service deleted',
  'pricing.settings.update': 'Pricing settings changed',
  'pricing.discount.denied': 'Discount above the limit refused',
  'branding.update': 'Branding updated',
  'branding.logo.update': 'Logo uploaded',
  'branding.logo.remove': 'Logo removed',
  'pipeline.config.activate': 'Pipeline version activated',
  'pipeline.approval.requested': 'Pipeline asked for an approval',
  'pipeline.approval.policy': 'Approved by the pipeline policy',
  'pipeline.stage.waiting': 'Pipeline waiting at a stage',
  'bulk.run.request': 'Bulk action started',
  'bulk.run.complete': 'Bulk action finished',
  'workspace.auto_send': 'Automatic sending changed',
  'webhook.receive': 'Provider event received',
  'webhook.process': 'Provider event processed',
  'webhook.purge': 'Stored event payload purged',
  'integration.simulated.create': 'Demo integration created',
  'sheets.mapping.simulated.create': 'Demo Sheets mapping created',
  'meta.form_mapping.simulated.create': 'Demo Meta form mapping created',
  'scoring.rescore': 'Leads rescored',
  'admin.elevate': 'Platform admin opened this workspace',
  'job.retry': 'Job retried by the platform admin',
  'job.cancel': 'Job cancelled by the platform admin',
  'invite.redeem': 'Invitation accepted',
  'demo.seed': 'Demo data loaded',
  'demo.refresh': 'Demo dates refreshed',
  // Lead-gen suite audit actions, each in its slice's block (docs/handoff/lead-gen-suite-plan.md §6).
  // ---- lead-gen F1 finder ----
  'finder.run.start': 'Lead finder search started',
  'finder.run.finish': 'Lead finder search finished',
  'finder.run.cancel': 'Lead finder search cancelled',
  'finder.import': 'Lead finder results imported as leads',
  'finder.export': 'Lead finder results downloaded (Excel)',
  'finder.results.purge': 'Expired lead finder details removed (24-hour copy)',
  'finder.results.refresh': 'Lead finder details refreshed',
  'finder.emails.extract': 'Websites checked for email addresses',
  'lead.places_expire': 'Unconfirmed Google Places details removed from leads',
  'lead.contact_confirm': 'Lead contact details confirmed',
  // ---- end F1 ----
  // ---- lead-gen F2 import ----
  'lead.import.upload': 'Lead file uploaded for preview',
  'lead.import.confirm': 'Lead file import started',
  'lead.import.complete': 'Lead file import finished',
  'lead.import.failed': 'Lead file import failed',
  'lead.import.expire': 'Unconfirmed lead file deleted',
  // ---- end F2 ----
  // ---- lead-gen F3 chat ----

  // ---- end F3 ----
  // ---- lead-gen F4 templates ----
  'template.draft.create': 'Template draft saved',
  'template.draft.update': 'Template draft changed',
  'template.draft.delete': 'Template draft deleted',
  'template.delete': 'Rejected template deleted',
  'template.submit': 'Template submitted for approval',
  'template.review': 'Template reviewed (simulated)',
  'media.upload': 'Brochure uploaded',
  // ---- end F4 ----
  // ---- lead-gen F5 handoff ----
  'lead.handoff': 'Lead handed over to the client',
  'lead.handoff.summary': 'Handoff summary written',
  'lead.handoff.acknowledge': 'Handed-over lead acknowledged',
  'conversation.handoff': 'Conversation passed to the client (AI off)',
  'workspace.reach_out': 'Opt-in notice or privacy contact changed',
  // ---- end F5 ----
  // ---- lead-gen F6 presentation ----

  // ---- end F6 ----
};

const FAMILIES: ReadonlyArray<readonly [prefix: string, icon: LucideIcon]> = [
  ['quote.', FileText],
  ['lead.', UserRound],
  ['import.', Webhook],
  ['webhook.', Webhook],
  ['ai.', Sparkles],
  ['reply.', MessagesSquare],
  ['conversation.', MessagesSquare],
  ['message.', Send],
  ['dispatch.', Send],
  ['quick_reply.', MessagesSquare],
  ['call_request.', MessagesSquare],
  ['consent.', ShieldCheck],
  ['suppression.', ShieldCheck],
  ['pricing.', Tags],
  ['branding.', Palette],
  ['pipeline.', Workflow],
  ['bulk.', Workflow],
  ['admin.', ShieldAlert],
  ['job.', ShieldAlert],
];

function words(action: string): string {
  const text = action.split(/[._\-\s]+/).filter(Boolean).join(' ').toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Updated';
}

export function activityLabel(action: string): string {
  return ACTIVITY_LABELS[action] ?? words(action);
}

export function activityIcon(action: string): LucideIcon {
  return FAMILIES.find(([prefix]) => action.startsWith(prefix))?.[1] ?? History;
}

const ACTOR_KIND_LABELS: Readonly<Record<string, string>> = {
  USER: 'Team member',
  EMPLOYEE: 'Operator',
  SUPER_ADMIN: 'Platform admin',
  SYSTEM: 'System',
  WORKER: 'Background job',
  WEBHOOK: 'Provider webhook',
  PUBLIC: 'Customer (quote page)',
};

export function actorLabel(actorName: string | null, actorKind: string): string {
  return actorName ?? ACTOR_KIND_LABELS[actorKind] ?? words(actorKind);
}
