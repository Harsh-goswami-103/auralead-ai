import type { DocPage } from '../format';

/**
 * The reach-out panel and the lead handoff (ADR-124, ADR-125, ADR-127, ADR-132, ADR-135). Facts are
 * taken from src/server/services/leads/handoff.ts, reach-out.ts and handoff-guard.ts,
 * src/server/services/messaging/consent.ts (opt-in rules), src/lib/schemas/consent.ts and
 * reach-out.ts, and src/components/handoff and reach-out.
 */
export const reachOutAndHandoff: DocPage = {
  slug: 'reach-out-and-handoff',
  title: 'Reach out and hand over',
  summary:
    'How an operator starts a lawful WhatsApp conversation with a lead (a recorded opt-in with its notice and method, or the business\'s own click-to-chat link) and how a converted lead is handed over to the client, who takes the conversation and closes the deal.',
  appliesTo: ['DEMO', 'LIVE'],
  checked: '2026-10-23',
  sections: [
    {
      id: 'reach-out-panel',
      title: 'The reach-out panel',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Leads found on a map or imported from a file have not agreed to WhatsApp messages from the business. The reach-out panel on the operator\'s lead page shows where this lead stands (an icon and a label: Opt-in on record, Customer messaged first, B2B basis attested, No WhatsApp opt-in, Opted out or No phone number, with what each allows) and offers the two lawful ways to start a conversation. Every send is still checked at dispatch; see [Messaging rules](/docs/messaging-rules).',
        },
        {
          kind: 'paragraph',
          text: 'After a lead is handed over to the client the panel says so and offers nothing: reaching out is the client\'s now.',
        },
      ],
    },
    {
      id: 'record-opt-in',
      title: 'Recording a WhatsApp opt-in',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Use **Record WhatsApp opt-in** when the person agreed outside the app. It needs `leads.write` and a phone number on the lead. A recorded opt-in is evidence that you can show later, so it asks for the facts:',
        },
        {
          kind: 'table',
          caption: 'What recording an opt-in asks for',
          head: ['Field', 'Rule'],
          rows: [
            ['Notice the customer agreed to', 'The words they saw or heard. Prefilled from the workspace setting (or a default); it must name the business. Kept word for word with its hash.'],
            ['How the customer agreed', 'One of: said yes on a phone call (`CALL_VERBAL`), signed a written form (`WRITTEN_FORM`), submitted a form on the business website (`WEBSITE_FORM`), agreed in person (`IN_PERSON`) or agreed in a WhatsApp conversation (`WHATSAPP_THREAD`).'],
            ['When they agreed', 'Required. The time of the agreement, not of the recording. Undated evidence is refused.'],
            ['What happened', 'At least 5 characters: who spoke to them, and where. A reference (a form number or call log entry) is optional.'],
          ],
        },
        {
          kind: 'list',
          items: [
            'For a WhatsApp marketing opt-in the method and the notice are required, and the notice must contain the business name; otherwise the request is refused with 422 (`EVIDENCE_METHOD_REQUIRED`, `NOTICE_REQUIRED`, `NOTICE_MISSING_BUSINESS_NAME`).',
            'Once recorded, approved templates can be sent to the lead, subject to the usual checks. The first recorded opt-in also confirms the contact, so a lead from Google Places keeps its details; see [Lead Finder](/docs/lead-finder#places-leads). The recording is audited.',
            'Record an opt-in only for a person who really agreed. A later Stop suppresses the contact whatever was recorded.',
            'A person with `automation.manage` (every workspace owner has it) can set the workspace\'s own **WhatsApp opt-in notice** and a **Privacy contact** in a section of the panel. The notice must name the business; empty means the default notice.',
          ],
        },
      ],
    },
    {
      id: 'click-to-chat',
      title: 'The click-to-chat link',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The click-to-chat link is a wa.me address made from the display number of the workspace\'s WhatsApp Business account and a first message of your choice, for example "Hi <business name>, I would like to know more about your services." Put it on the business\'s own channels: an email signature, the website, a visiting card. The customer taps it and writes first, which opens the 24-hour window for replies. That is a conversation the customer started; it is not a marketing opt-in.',
        },
        {
          kind: 'list',
          items: [
            'The link needs the display phone number in the WhatsApp integration settings (`displayPhoneNumber`) and an integration that is neither unconfigured nor revoked. Without it the button explains what is missing.',
            'A first message that is only a Start or Stop keyword is refused (`PREFILL_IS_KEYWORD`), because it would be read as an opt-in change. The link is built on the server and nothing is stored.',
            'The app does not send the link to anyone. It is for you to publish.',
          ],
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'In DEMO the display number is a simulated Indian mobile number that looks real. Copy the link instead of opening it: opening a wa.me link in your own browser starts a real chat with whoever owns that number.',
        },
      ],
    },
    {
      id: 'handoff',
      title: 'Handing a lead over to the client',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The operator (the AuraLead team or agency) finds and warms leads. When a lead is ready, the operator hands it to the client, the business that owns the workspace, who continues the conversation and closes the deal with the [quotation flow](/docs/lead-to-quote-workflow). Press **Hand over to client** on the lead page. It needs `leads.handoff` (owners hold it; operators when granted). A dialog lists what will happen and takes an optional note for the client.',
        },
        {
          kind: 'ordered',
          items: [
            'The lead moves to Converted (a lead already Converted stays there). A lost lead is refused (`LEAD_LOST`: move it back to an open stage first) and so is a lead merged into another (`LEAD_MERGED`).',
            'Every open conversation of the lead is set to AI off and marked as handled by a person.',
            'Message drafts waiting for approval are withdrawn. Messages queued by operators or by the automation that have not gone out yet are cancelled. The client\'s own queued sends and quotation sends stay.',
            'The lead\'s open automated pipeline stops.',
            'A short summary for the client (what the customer asked, what was promised, the next step) is written by the workspace\'s AI integration. Without one the card reads "No AI integration: no summary" and the note is what the client reads first; the app never writes a stand-in.',
          ],
        },
        {
          kind: 'list',
          items: [
            'All of it happens in one step. If the lead or a conversation changed meanwhile (`STAGE_VERSION_CONFLICT`, `MODE_VERSION_CONFLICT`, both 409), nothing is changed and the operator tries again. A lead can be handed over once: a second attempt is 409 `ALREADY_HANDED_OVER`, and a double click returns the first result. The limit is 30 handovers a minute per person (`handoff`).',
            'The audit event `lead.handoff` holds ids, stages and counts, never the note or the summary.',
          ],
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'In DEMO the summary is written by the local template generator, labelled "Local template".',
        },
      ],
    },
    {
      id: 'after-handoff',
      title: 'After the handoff',
      blocks: [
        {
          kind: 'table',
          caption: 'What each side sees',
          head: ['Side', 'What changes'],
          rows: [
            [
              'Operator',
              'The lead and its conversation are read-only, with a "Handed over" chip. Sending is refused with 409 `HANDED_OVER` in the composer, in drafts, in approvals, in quotation sends and in the mode, takeover and resume controls; in a bulk run the lead is a failed row ("Handed over to the client"). This is not one of the eligibility reason codes. A conversation that opens after the handoff, because the customer writes first, also starts with AI off and taken over.',
            ],
            [
              'Client',
              'The command center\'s "Needs you" list gains a "Handed over to you" line with a count; it opens the Leads list filtered to handed-over leads. The lead shows who handed it over and when, the note, the summary (marked as AI-written, or with its status) and **Acknowledge**. The inbox gets a **Handed over** filter, a badge and a timeline event, "Handed over to <client> by <operator>".',
            ],
          ],
        },
        {
          kind: 'list',
          items: [
            '**Acknowledge** is for workspace members (`leads.read`); it marks the handoff Acknowledged once and is audited (`lead.handoff.acknowledge`). It changes nothing else.',
            'The client replies in the thread (the handoff already took it over) and creates the quotation as usual: [From lead to quotation](/docs/lead-to-quote-workflow).',
          ],
        },
        {
          kind: 'callout',
          tone: 'limit',
          text: 'The client panel\'s Leads list opens a lead in a sheet, so the handoff card with Acknowledge appears there as well as on the lead page. An operator\'s stage changes and lead edits are not blocked by a handoff; only messaging and the conversation controls are.',
        },
      ],
    },
    {
      id: 'handoff-data',
      title: 'What is kept',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The note and the summary are kept with the lead until the lead is erased with `npm run lead:erase`, which deletes the handoff record. [Data and privacy](/docs/data-and-privacy#retention) lists every retention period.',
        },
      ],
    },
  ],
};
