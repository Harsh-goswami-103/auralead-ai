import type { DocPage } from '../format';

export const leadToQuoteWorkflow: DocPage = {
  slug: 'lead-to-quote-workflow',
  title: 'From lead to quotation',
  summary:
    'How a lead is ingested, de-duplicated, scored and drafted, and how a versioned quotation is priced, approved, rendered as a PDF, shared and accepted, with the states it moves through.',
  appliesTo: ['DEMO', 'LIVE'],
  checked: '2026-10-20',
  sections: [
    {
      id: 'overview',
      title: 'The path of a lead',
      blocks: [
        {
          kind: 'ordered',
          items: [
            'A source delivers one or more records. The delivery is stored first, then the worker ingests it.',
            'Each record is normalized and matched against the workspace\'s existing contacts: a new lead, a duplicate, or a case for review.',
            'A new lead runs the workspace\'s pipeline: score, AI draft, approval, delivery.',
            'A quotation is created from the draft proposal or by hand, priced by the server from the active price list.',
            'A person approves the quotation version. The worker renders its PDF.',
            'The quotation is handed over (sent through a channel, or as a share link) and the customer can accept it.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Every step writes an audit event that shares one correlation id with the request or job that caused it, so a lead\'s history can be followed end to end in the job inspector.',
        },
      ],
    },
    {
      id: 'ingestion',
      title: 'Ingestion',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Every source goes through the same ingestion. Leads arrive from Google Sheets form rows (`/api/webhooks/google-sheets`), Meta Lead Ads (`/api/webhooks/meta-ads`), the Maps extension (`/api/webhooks/gmaps-extension`) and inbound WhatsApp messages: a message from a number the workspace does not know yet creates a lead (a Stop never does).',
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'In DEMO the source simulators in the lead console (`/api/demo/simulate/<source>`) deliver the same records, and the Inbox simulates inbound WhatsApp messages from existing leads.',
        },
        {
          kind: 'list',
          items: [
            'A delivery is stored as a webhook event with two copies: a redacted view for the inspector, and the full body encrypted with the key ring for processing. The worker\'s `ingest.process` job decrypts only the processing copy.',
            'Deliveries are idempotent: the same event received twice creates nothing new and answers with the stored result. The same batch id with different content is refused (`BATCH_CONTENT_MISMATCH`).',
            'Ingestion never runs scoring or drafting itself. It creates the lead, its source record and exactly one `pipeline.advance` job, and the pipeline does the rest.',
          ],
        },
      ],
    },
    {
      id: 'normalize-dedupe',
      title: 'Normalization and duplicates',
      blocks: [
        {
          kind: 'list',
          items: [
            'Phone numbers become E.164 (India by default); email addresses are trimmed and lower-cased. An email is never invented, and placeholder addresses are dropped.',
            'Each lead gets contact keys (phone, email, provider id) that are unique within the workspace.',
            'A record that matches no lead creates one (ACCEPTED). One that matches exactly one lead is a DUPLICATE linked to it, and the existing lead is not changed. One that matches two or more leads is held for REVIEW with a merge review, and nothing is written to the candidates. A record that cannot be normalized is REJECTED with a reason.',
            'When the source mapping has a consent column (Sheets) or question (Meta) and the answer is yes, an OPT_IN consent is recorded for the mapped channel and purpose, with the form, the response, the submission time and a hash of the notice text. No mapping, a missing column or another answer records nothing. Maps extension leads never get WhatsApp consent.',
          ],
        },
      ],
    },
    {
      id: 'pipeline',
      title: 'The pipeline',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A new lead is pinned to the workspace\'s active pipeline version at ingestion, so a later change to the pipeline never alters a lead already in flight. The stages run in order, each at most once per lead (a replayed job or a worker restart cannot repeat a stage):',
        },
        {
          kind: 'table',
          caption: 'Pipeline stages',
          head: ['Stage', 'What happens'],
          rows: [
            ['`INGESTION`', 'The lead and its source record exist.'],
            ['`SCORE`', 'The website check (LIVE only), then the score.'],
            ['`DRAFT`', 'One AI draft for the lead.'],
            ['`APPROVAL`', 'In approval mode HUMAN (the default), a sendable draft becomes an item in the approval queue. In POLICY_AUTO, which needs workspace auto-send on, a clean draft is approved by policy.'],
            ['`DELIVERY`', 'After a policy approval, queues the first message as an automated send, and dispatch checks everything again at send time. After a human review item it sends nothing: a person approves and sends from the queue.'],
          ],
        },
        {
          kind: 'paragraph',
          text: 'A stage whose handler is missing halts visibly with `STAGE_HANDLER_MISSING`. `npm run pipeline:resume` queues one `pipeline.advance` for each halted stage that now has a handler; running it again adds nothing.',
        },
      ],
    },
    {
      id: 'scoring',
      title: 'Scoring',
      blocks: [
        {
          kind: 'list',
          items: [
            'The score runs from 0 to 100 over seven inputs: phone present, email present, website status, rating, review count, category match and source intent. The weights come from the workspace\'s scoring version and add up to 100.',
            'A known input earns points and becomes a reason, including known zeros such as "No email on record". An unknown input earns nothing and is listed as unknown, never counted against the lead. The score is the sum of its reasons, so it is always fully explained.',
            'Only a reachable website or one a person verified as absent counts. In LIVE the worker checks a website through a hardened fetch that refuses private and local addresses; a DNS miss or a timeout means unreachable, never absent.',
            'The screen labels it "Heuristic fit score. Not purchase intent or consent." A stored score keeps the scoring version it was computed with.',
          ],
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'DEMO makes no network request, so websites stay unchecked.',
        },
      ],
    },
    {
      id: 'drafts',
      title: 'AI drafts',
      blocks: [
        {
          kind: 'paragraph',
          text: 'One draft holds template variable values, a follow-up message, an email subject and body, and a quotation proposal with service ids, quantities, scope and timeline. It never holds a price.',
        },
        {
          kind: 'list',
          items: [
            'Drafts come from the workspace\'s own AI integration (Anthropic first, then OpenAI). When none is usable, the draft is stored as `NEEDS_REVIEW` with the reason `AI_NOT_CONFIGURED` and no generated text, and the lead page offers **Generate with local template**, whose output is labelled `local-deterministic`. The app never switches to the local generator on its own.',
            'Price, discount or tax values in the model output are stripped and flagged (for example `ai_price_ignored`), and the draft goes to review. Unknown service ids are dropped into the review reasons, never guessed. Amounts, links, phone numbers, email addresses and payment wording in the text also send the draft to review.',
            'Malformed or truncated output gets exactly one repair attempt; after that the draft is marked `NEEDS_REVIEW`. Website text and customer messages reach the model only as capped, delimited data.',
          ],
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: '**DEMO** always uses the local deterministic generator, labelled `local-deterministic`: the same input gives the same draft and nothing leaves the app.',
        },
      ],
    },
    {
      id: 'approvals',
      title: 'Approvals',
      blocks: [
        {
          kind: 'list',
          items: [
            'Nothing reaches a customer without an approval: a person\'s, or the pipeline policy\'s in POLICY_AUTO mode.',
            'An approval is bound to the exact payload: channel, destination, template, variables, body, subject and the attached quotation PDF. If any of it changes afterwards, the send is skipped as `APPROVAL_STALE` and nothing is sent.',
            'Approve and send runs once even after a double click or a retry; the duplicates answer with the same result.',
            'Approving a quotation needs the version you saw. If someone changed it meanwhile, the answer is 409 and the screen says the item changed.',
          ],
        },
      ],
    },
    {
      id: 'quotations',
      title: 'Quotations and versions',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A quotation is numbered per workspace (Q-0001, Q-0002, ...) and every material change creates a new version. Each version keeps its own copy of service names, unit prices and rules, so a later price list change never alters an issued quotation.',
        },
        {
          kind: 'table',
          caption: 'Quotation states',
          head: ['State', 'Reached when', 'What happens'],
          rows: [
            ['`DRAFT`', 'Created, or revised from any open state', 'Version 1 (or N+1) with totals computed and stored.'],
            ['`APPROVED`', 'A person approves the current version', 'Only with the expected version, no pricing review pending and validity not passed.'],
            ['`SENT`', 'A send settles, or the link is copied or marked as sent', 'Creating a share link alone does not send it.'],
            ['`VIEWED`', 'The shared page stayed visible for 2 seconds in a browser', 'Shown as "Opened (may be automated)": it is not proof a person read it.'],
            ['`ACCEPTED`', 'The customer accepts the current version before it expires', 'One acceptance per version; the lead moves to CONVERTED.'],
            ['`EXPIRED`', 'The validity date passes', 'Checked by a sweep job and again on every read and accept.'],
            ['`CANCELLED`', 'Someone cancels it', 'Its share links stop working at once.'],
          ],
        },
        {
          kind: 'list',
          items: [
            'Editing an APPROVED quotation (items, quantities, prices, discount, tax, scope, timeline or validity) creates version N+1 in one step: the approval is invalidated, queued sends are cancelled and old share links are superseded.',
            'Nothing leaves ACCEPTED or CANCELLED, and an expired quotation can only be revised and reissued.',
          ],
        },
      ],
    },
    {
      id: 'quote-math',
      title: 'Quotation math',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Money is stored as whole paise (64-bit integers) and every amount is rounded once, half up. The discount applies to the subtotal and tax to the discounted subtotal, with one configured tax line. Each quotation says "Quotation, not a tax invoice".',
        },
        {
          kind: 'table',
          caption: 'Worked example: two units at ₹10,000, 10% discount, 18% GST',
          head: ['Step', 'Amount'],
          rows: [
            ['2 x ₹10,000.00', '₹20,000.00'],
            ['Discount 10%', '₹2,000.00'],
            ['Taxable', '₹18,000.00'],
            ['GST 18%', '₹3,240.00'],
            ['Total', '₹21,240.00'],
          ],
        },
        {
          kind: 'paragraph',
          text: 'Discounts above the workspace or service limit are refused (`DISCOUNT_OVER_LIMIT`); see [discount limits and caps](/docs/roles-and-panels#discount-caps). A total above ₹100 crore, or a service without an active price, sends the quotation to pricing review.',
        },
      ],
    },
    {
      id: 'pdf',
      title: 'The PDF',
      blocks: [
        {
          kind: 'list',
          items: [
            'The worker renders a PDF for every new version (`quote.renderPdf`) from the stored totals, which are never recomputed for display. It embeds the Inter font so the ₹ sign prints everywhere.',
            'Every page footer shows the quotation number, the version, a short content hash (the same one the HTML view shows), "Quotation, not a tax invoice" and "Page n of N". The file is stored under the storage folder at `quotes/<workspaceId>/<quoteVersionId>.pdf` with its sha256, which is checked again before every download.',
            'Signed-in users download it from the lead page or the quotation. The shared page offers it too, and answers 503 with Retry-After while the PDF is still being rendered.',
          ],
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'DEMO PDFs carry the watermark "DEMO: not a valid offer" on every page.',
        },
      ],
    },
    {
      id: 'sharing',
      title: 'Share links and acceptance',
      blocks: [
        {
          kind: 'list',
          items: [
            '**Create share link** makes a link for the current version. The token is 32 random bytes, shown once; only its sha256 is stored. A link never outlives the quotation\'s validity.',
            '**Copy link** on an APPROVED quotation marks it Sent only after the copy succeeded. **Mark as sent manually** covers a PDF handed over another way. Links can be revoked.',
            'The public page `/quote/<token>` uses no cookies. An unknown, revoked or cancelled link answers 404 with one identical page; an expired or superseded link answers 410 and names the sender; more than 30 requests a minute from one address answer 429.',
            'To accept, the customer types their name (2 to 120 characters). The request must come from the app\'s own origin with the page\'s signed form nonce, for the version the page showed, before the validity date. A repeated accept returns the same receipt.',
            'The page is served with no-referrer, noindex and no-store headers, so the link does not leak through referrers, search engines or caches.',
          ],
        },
      ],
    },
    {
      id: 'sales-stages',
      title: 'Sales stages',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A lead\'s sales stage is one of `NEW`, `CONTACTED`, `REPLIED`, `QUOTE_SENT`, `CONVERTED` and `LOST`. Automatic moves only go forward: handing over a quotation moves the lead to QUOTE_SENT and an acceptance to CONVERTED. The stage never decides consent, approval or delivery; those follow [the messaging rules](/docs/messaging-rules).',
        },
      ],
    },
  ],
};
