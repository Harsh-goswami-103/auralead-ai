import type { DocPage } from '../format';

/**
 * The template studio (ADR-17, ADR-123, ADR-131). Facts are taken from
 * src/lib/domain/template-authoring.ts (categories, limits, warnings), src/lib/domain/lead-gen.ts
 * (statuses), src/server/services/integrations/template-authoring.ts and media-assets.ts
 * (submission, brochures), the template-admin adapters and src/components/templates.
 */
export const templateStudio: DocPage = {
  slug: 'template-studio',
  title: 'Template studio',
  summary:
    'Write WhatsApp message templates in the app, check them against the category rules, preview them as a chat bubble, submit them for review and follow the verdict. Covers the Marketing and Utility rules, the Stop button, PDF brochure headers, submission and what is sent.',
  appliesTo: ['DEMO', 'LIVE'],
  checked: '2026-10-23',
  sections: [
    {
      id: 'overview',
      title: 'What the studio does',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A business can start a WhatsApp conversation, or restart one after the 24-hour window, only with a template that Meta has approved. The studio, `/dashboard/employee/<ws>/templates`, is where an operator writes one, sees it as the customer will, submits it for review and follows the verdict. Templates made in WhatsApp Manager still appear on the page under "Synced from WhatsApp Manager", where their variables and buttons are mapped on the WhatsApp setup page.',
        },
        {
          kind: 'list',
          items: [
            'Anyone with `leads.read` can open the page. Creating, editing, submitting and deleting need `templates.manage`; without it the controls show why they are unavailable.',
            'In LIVE the studio needs the workspace\'s WhatsApp Cloud API integration; without it the page shows a configuration gate instead of the editor.',
            'Only a template whose status is exactly `APPROVED` can be sent. Statuses are shown with an icon and a word; the provider\'s own status is stored as it reports it.',
          ],
        },
        {
          kind: 'table',
          caption: 'Template statuses',
          head: ['Status shown', 'Meaning', 'Sendable'],
          rows: [
            ['Draft', 'Saved in the studio, not submitted.', 'No'],
            ['Submitting to Meta', 'The submission is in flight.', 'No'],
            ['Pending review', 'Meta has it and has not decided.', 'No'],
            ['Approved', 'Meta approved it.', 'Yes'],
            ['Rejected', 'Meta refused it; the reason is shown.', 'No'],
            ['Paused by Meta, Disabled by Meta, In appeal', 'Meta changed an approved template.', 'No'],
          ],
        },
      ],
    },
    {
      id: 'category',
      title: 'Choose the category first',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The person writing chooses the category before anything else, and nothing changes it afterwards: the AI that suggests the wording is told the category and cannot alter it. Authentication templates are not offered.',
        },
        {
          kind: 'table',
          caption: 'The two categories',
          head: ['Category', 'For', 'Rules in the studio'],
          rows: [
            [
              '`MARKETING`',
              'Introductions, offers, brochures and follow-ups.',
              'Carries a **Stop** quick-reply button by default, mapped to the same Stop as the keyword. The studio warns if you remove it, because a customer should be able to opt out with one tap.',
            ],
            [
              '`UTILITY`',
              'A reply to something the customer started: a request, a booked meeting, an issued quotation.',
              'Needs a "sent when" trigger: the customer asked for it in the chat, a meeting was booked, or a quotation was issued. The studio warns about promotional words (offer, discount, free, % off, brochure, launch) and about a PDF brochure header, because Meta may recategorize or reject a Utility template that promotes.',
            ],
          ],
        },
        {
          kind: 'list',
          items: [
            'Warnings never block saving or submitting: the category is the person\'s decision, and Meta has the final say.',
            'The category does not change who may be messaged. In this app every template send needs a WhatsApp opt-in for marketing, whatever the category; see [Messaging rules](/docs/messaging-rules#consent).',
          ],
        },
      ],
    },
    {
      id: 'writing',
      title: 'Writing the template',
      blocks: [
        {
          kind: 'table',
          caption: 'What the form enforces',
          head: ['Part', 'Rule'],
          rows: [
            ['Name', 'Lowercase letters, digits and underscores, up to 512 characters, for example website_intro. A language is chosen from WhatsApp\'s template languages.'],
            ['Header', 'None; text of at most 60 characters with at most one variable; or a PDF document (see [PDF brochure headers](#brochure)).'],
            ['Body', 'Required, at most 1,024 characters. Variables are numbered `{{1}}`, `{{2}}` and so on in order without gaps, at most 10, and never at the very start or end of the body.'],
            ['Footer', 'Optional, at most 60 characters, no variables.'],
            ['Buttons', 'At most 3 quick replies, 2 website links (a fixed https address) and 1 call button, each with a text of at most 25 characters. Quick replies come first, as WhatsApp requires.'],
            ['Examples', 'Every variable needs an example value before the template can be submitted, because Meta reviews it with them.'],
          ],
        },
        {
          kind: 'list',
          items: [
            'Each variable has a source, so the value is filled for every lead at send time: first name, customer name, city, business category or your business name (`lead.firstName`, `lead.displayName`, `lead.city`, `lead.category`, `workspace.name`), or a value the person typed at send time. Insert buttons put a numbered variable into the body for you. The same values work in the inbox composer and in bulk sends.',
            '**Generate with AI** drafts the wording for the category you chose. The result is checked: variables only as numbers, and no prices. In LIVE it needs the workspace\'s AI integration (otherwise the button explains why it is unavailable) and the result is labelled with the model that wrote it.',
            'The preview is a WhatsApp-style bubble of the draft with its examples filled in. **Save draft** keeps the template as Draft.',
          ],
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'In DEMO the same button reads **Generate with local template** and a deterministic generator writes web-development copy for the chosen category; it is not AI and is labelled local-deterministic.',
        },
        {
          kind: 'callout',
          tone: 'limit',
          text: 'Meta\'s limits above are the rules as the project understood them on 23 Oct 2026, from documentation read through search results. They are unverified until a live check, so Meta can still refuse a template the form accepted.',
        },
      ],
    },
    {
      id: 'brochure',
      title: 'PDF brochure headers',
      blocks: [
        {
          kind: 'list',
          items: [
            'A document header holds a PDF from the workspace\'s media library: `application/pdf`, a .pdf name, the %PDF- signature, at most 5 MB. Upload one in the editor or pick one already there. The file is stored in the storage folder (`media/<workspace>/<id>.pdf`) and its size and sha256 are checked every time it is read.',
            'A brochure is promotion, so it belongs in a Marketing template. A Utility template with one gets a warning, not a block.',
            'To submit a template with a document header in LIVE, the WhatsApp integration needs the Meta app ID (the `appId` setting): Meta takes a sample of the document through a resumable upload on the app. Without it the submission is refused with `INTEGRATION_NOT_CONFIGURED` before anything changes. A failed sample upload creates nothing at Meta and returns the template to Draft.',
            'When the template is sent, the brochure is uploaded per send, like a quotation PDF. A template with its own brochure cannot also carry a quotation (`TEMPLATE_HAS_OWN_DOCUMENT`), and the quotation approval does not offer it. A file that changed or went missing fails the send (`ARTIFACT_INTEGRITY`, `MEDIA_MISSING`).',
            'There is no way yet to delete a brochure from the library, and `npm run db:backup` does not include the storage folder, so copy `media/` with your other files.',
          ],
        },
      ],
    },
    {
      id: 'submission',
      title: 'Submitting and review',
      blocks: [
        {
          kind: 'ordered',
          items: [
            'Press **Submit for approval**. The studio checks the template again (examples, trigger, document). A workspace may submit 20 templates an hour (the `templateSubmit` limit).',
            'The template becomes "Submitting to Meta" and one background job (`wa.templateSubmit`) sends it to Meta. On success the template is "Pending review" with Meta\'s identifier, and a sync (`wa.templateSync`) reads the verdict at least a minute later. The regular sync every six hours keeps it current too.',
            'The verdict arrives as Approved, or Rejected with Meta\'s reason. Authored templates are matched to Meta\'s list by name and language, and a Draft or a template still being submitted is never counted as missing.',
          ],
        },
        {
          kind: 'list',
          items: [
            'The app never resubmits on its own. After a timeout, a server error, an answer without an identifier or a "name already exists" answer, the template stays "Submitting to Meta" and the sync decides by name and language. If Meta never received it, the sync returns the template to Draft after at least a minute (`NOT_FOUND_AFTER_SUBMIT`) so you submit again. A definite refusal returns it to Draft at once with the reason.',
            'A draft is deleted from the studio only. A rejected template of your own is deleted at Meta first, so the name can be used again. Other statuses, and templates that already have messages, cannot be deleted here (`TEMPLATE_NOT_DELETABLE`).',
            'Not supported yet: image and video headers, header variables filled at send time, link buttons with a variable, and editing an approved template.',
          ],
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'In DEMO a submission is Pending review at once, and 30 seconds later a simulated review (`wa.templateReview`) approves it. A template whose name contains the word reject is refused with a stated reason, so both outcomes can be shown. Everything on screen is labelled Simulated and Meta is never contacted.',
        },
        {
          kind: 'callout',
          tone: 'limit',
          text: 'The Meta calls that create and delete a template and upload a sample are built from documentation snippets and tested against fixtures. They are listed as unverified in docs/integrations.md until one live check with a real WhatsApp Business account and Meta app.',
        },
      ],
    },
    {
      id: 'sending',
      title: 'Sending an approved template',
      blocks: [
        {
          kind: 'list',
          items: [
            'An approved template goes out from the inbox composer, from bulk sends and from the approval queue, always through the one eligibility check: it needs an opt-in, a connected integration and no pause or opt-out. [Messaging rules](/docs/messaging-rules) lists every refusal.',
            'In a bulk send, a body position filled from the lead or the business is resolved for each lead; only positions marked as typed take a value you enter. A lead that was handed over to the client is reported as a failed row ("Handed over to the client") in an operator\'s run.',
            'Leads found on a map or imported from a file have no WhatsApp opt-in, so a template send to them is skipped with `NO_WHATSAPP_OPT_IN`. Record a real opt-in first; see [Reach out and hand over](/docs/reach-out-and-handoff#record-opt-in).',
          ],
        },
      ],
    },
  ],
};
