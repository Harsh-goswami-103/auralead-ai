import type { DocPage } from '../format';

export const messagingRules: DocPage = {
  slug: 'messaging-rules',
  title: 'Messaging rules',
  summary:
    'When AuraLead may send a WhatsApp message or an email: consent and its sources, the 24-hour WhatsApp window, templates, Stop and unsubscribe, suppression, every eligibility reason code, and the pauses.',
  appliesTo: ['DEMO', 'LIVE'],
  checked: '2026-10-20',
  sections: [
    {
      id: 'one-check',
      title: 'One check, run again at send time',
      blocks: [
        {
          kind: 'paragraph',
          text: 'One eligibility function decides every send. The same result drives the composer line, the approval queue badge, the bulk pre-flight counts and, last, the dispatch preflight that runs inside the send job just before the provider call. The screen says "Final check happens at send" because the answer can change between approval and send: a Stop, a closed window or a pause is always honored at that last check.',
        },
        {
          kind: 'list',
          items: [
            'Every outbound send goes through one outbox. The attempt is marked `SENDING` and committed before the provider is called, so a crash can never cause a silent second send.',
            'Each send carries its intent from the moment it is created: a manual single send, a bulk send, an automated send, or a reply the customer asked for. Rules that apply only to automated sends read that stored intent, never a guess.',
            'A channel needs a connected integration, otherwise the send is refused with `NOT_CONFIGURED`.',
          ],
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'In DEMO every channel uses the built-in demo transport: messages are labelled Simulated and nothing leaves the app.',
        },
      ],
    },
    {
      id: 'consent',
      title: 'Consent and its sources',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A consent record belongs to a contact (the keyed hash of the phone number or email address), a channel and a purpose, and keeps its basis, its source, its evidence and the time the evidence was collected.',
        },
        {
          kind: 'table',
          caption: 'Consent sources',
          head: ['Source', 'Recorded when', 'Basis'],
          rows: [
            ['`SHEETS_FORM`', 'A Sheets row answers yes in the mapped consent column; the notice text hash is stored.', '`OPT_IN`'],
            ['`META_FORM`', 'A Meta lead form answers yes to the mapped consent question; the notice text hash is stored.', '`OPT_IN`'],
            ['`INBOUND_MESSAGE`', 'The customer writes to the business on WhatsApp. It covers the service conversation only.', '`INBOUND_MESSAGE`'],
            ['`START_KEYWORD`', 'The customer sends START after a Stop.', '`OPT_IN`'],
            ['`MANUAL_EVIDENCE`', 'A person records an opt-in with its channel, purpose, an evidence note and the time it was given (`/api/app/consent/grants`). Such a record may also cite a Sheets or Meta form; a Maps listing is never evidence, and undated evidence is refused.', '`OPT_IN`'],
            ['`EMPLOYEE_ATTESTATION`', 'Someone in the workspace attests, with a note, that a business may be emailed. Only when the workspace enables B2B attestation, which is off by default (`/api/app/consent/attestations`).', '`B2B_ATTESTED`'],
          ],
        },
        {
          kind: 'table',
          caption: 'What each kind of send needs',
          head: ['Send', 'Needs'],
          rows: [
            ['WhatsApp template', 'An `OPT_IN` WhatsApp consent for marketing that is not withdrawn, and an approved template.'],
            ['WhatsApp free-form', 'Any WhatsApp consent, including a customer\'s own message, and an open 24-hour window.'],
            ['Email', 'A valid address and an email basis: an email `OPT_IN` allows every kind of send; an attested B2B contact allows a manual single send only. WhatsApp consent never counts for email.'],
          ],
        },
        {
          kind: 'callout',
          tone: 'warning',
          text: 'Leads from the Maps extension never carry WhatsApp consent, so a template send to them is refused with `NO_WHATSAPP_OPT_IN` and never attempted.',
        },
      ],
    },
    {
      id: 'window',
      title: 'The 24-hour WhatsApp window',
      blocks: [
        {
          kind: 'list',
          items: [
            'The window is open while the current time is earlier than the customer\'s last inbound message plus exactly 24 hours, measured from the provider\'s own timestamp. There is no safety margin and no rounding.',
            'Only valid inbound messages move it: text, media, button and quick replies. Template sends, delivery statuses, quotation link opens, echoes and the business\'s own free-form messages never do, and a late, older inbound message never shortens it.',
            'The composer shows "Free-form until" with the closing time, and the check runs again at send. A free-form message whose window closed before it was sent is skipped with `WINDOW_CLOSED` and goes back for review or a template; it is never sent as free-form.',
          ],
        },
      ],
    },
    {
      id: 'templates-and-quick-replies',
      title: 'Templates and quick replies',
      blocks: [
        {
          kind: 'list',
          items: [
            'A template send needs a stored template whose provider status is approved. Status and category are kept exactly as the provider reports them. Otherwise the send is refused with `TEMPLATE_NOT_APPROVED`.',
            'Quick replies are recognized by their payload id: `AL_QR_QUOTE_V1` (get the quotation), `AL_QR_CALL_V1` (request a call) and `AL_QR_STOP_V1` (stop). When a provider does not echo the payload, the button text is matched against a fixed list; an unknown payload goes to a person.',
            'Get quote with an approved current quotation queues its PDF as a document reply; without one, the lead\'s draft quotation is flagged as customer requested for approval. Request a call creates exactly one call request per message, even when the message is delivered twice.',
            'Every such reply goes through the outbox as a customer-requested reply, so consent, window, suppression and pauses are checked at send time like any other send.',
          ],
        },
      ],
    },
    {
      id: 'stop-and-unsubscribe',
      title: 'Stop and unsubscribe',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A Stop is applied inside the same request that receives it, even when the worker is down: the suppression is written, the contact\'s queued sends on that channel are cancelled, and the audit event is recorded in one transaction. A send that was already `SENDING` is left to finish. A message is a Stop when it is the Stop quick reply, or when its whole text (case and trailing punctuation ignored) is one of these keywords; a keyword inside a longer message does not count.',
        },
        {
          kind: 'table',
          caption: 'Whole-message keywords',
          head: ['Intent', 'Keywords'],
          rows: [
            ['Stop', '`stop`, `stop all`, `stopall`, `unsubscribe`, `opt out`, `optout`, `opt-out`, `बंद`, `बंद करें`, `बंद करो`, `रोकें`, `रोको`'],
            ['Start', '`start`, `subscribe`, `शुरू`, `शुरू करें`'],
          ],
        },
        {
          kind: 'list',
          items: [
            'Every email carries a signed unsubscribe link (`/unsubscribe/<token>`) and List-Unsubscribe headers. The link names no address and cannot be moved to another contact. Unsubscribing is applied at once, in the same way as a Stop.',
            'A hard bounce or a complaint reported for an email address suppresses that address for email.',
            'A Stop never creates a lead, and a Stop from a contact that is already suppressed only adds an audit event.',
          ],
        },
      ],
    },
    {
      id: 'suppression',
      title: 'Suppression',
      blocks: [
        {
          kind: 'list',
          items: [
            'A suppression belongs to a workspace, a channel and a contact key: an HMAC-SHA256 of the normalized phone number or email address under `SUPPRESSION_PEPPER`. It is not tied to a lead, so merging, re-importing or erasing the lead cannot remove it.',
            'Suppressions are history: there is at most one active row per contact and channel, and rows are never deleted. The reasons are `STOP_BUTTON`, `STOP_KEYWORD`, `UNSUBSCRIBE`, `HARD_BOUNCE`, `COMPLAINT`, `MARKETING_STOPPED` and `MANUAL`.',
            'Only a new `OPT_IN` consent collected strictly after the latest Stop clears it, for example START sent after the Stop. Older, undated or backfilled evidence never does, so Stop, START, Stop and then a delayed form answer from before the second Stop stays suppressed.',
            'Every Stop and every clear is also appended to the suppression journal, a file outside the database (`journal/` in the data folder). A database restore replays it, so an opt-out recorded after the backup is never lost.',
          ],
        },
      ],
    },
    {
      id: 'reason-codes',
      title: 'Eligibility reason codes',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Checks run in this order and every failing check is reported. A send waits (it stays queued and runs later) only when every reason it has is one that waits; otherwise it is skipped with its reasons, so a suppressed contact is skipped even while outbound is paused. "Automated" means an automated send, or a customer-requested reply that no person approved.',
        },
        {
          kind: 'table',
          caption: 'Reason codes in check order',
          head: ['Reason code', 'What the screen says', 'Outcome', 'Applies to'],
          rows: [
            ['`GLOBAL_PAUSED`', 'Outbound is paused for the whole system', 'Waits', 'Every send'],
            ['`WORKSPACE_PAUSED`', 'Automation is paused for this workspace', 'Waits', 'Automated sends'],
            ['`AUTO_SEND_DISABLED`', 'Auto-send is off', 'Skipped', 'Automated sends, also when a policy approval\'s pipeline is no longer in POLICY_AUTO'],
            ['`SUPPRESSED`', 'The contact opted out on this channel', 'Skipped', 'Every send on that channel'],
            ['`NO_WHATSAPP_OPT_IN`', 'No WhatsApp opt-in on record', 'Skipped', 'WhatsApp'],
            ['`EMAIL_INVALID`', 'No valid email address', 'Skipped', 'Email'],
            ['`NO_EMAIL_BASIS`', 'No email opt-in or enabled B2B attestation', 'Skipped', 'Email'],
            ['`ATTESTED_MANUAL_ONLY`', 'Attested B2B email allows manual single sends only', 'Skipped', 'Email with only an attestation, other than a manual single send'],
            ['`HUMAN_TAKEOVER`', 'A person has taken over this conversation', 'Skipped', 'Automated sends'],
            ['`MODE_CHANGED`', 'The conversation mode changed after this was queued', 'Skipped', 'Automated replies'],
            ['`QUALITY_PAUSED`', 'Automation paused by WhatsApp quality rating', 'Skipped', 'Automated WhatsApp sends'],
            ['`TEMPLATE_NOT_APPROVED`', 'The template is not approved', 'Skipped', 'WhatsApp template'],
            ['`WINDOW_CLOSED`', 'The 24-hour reply window is closed', 'Skipped', 'WhatsApp free-form'],
            ['`NOT_CONFIGURED`', 'The channel integration is not connected', 'Skipped', 'LIVE only'],
            ['`CAP_REACHED`', 'Internal cap, not a provider limit', 'Waits', 'Workspaces with a daily send cap'],
          ],
        },
        {
          kind: 'paragraph',
          text: 'The codes and their order come from `src/server/services/messaging/eligibility.ts`; this table is checked against it by the documentation tests.',
        },
      ],
    },
    {
      id: 'pauses',
      title: 'Pauses and takeover',
      blocks: [
        {
          kind: 'list',
          items: [
            '**Global outbound pause.** Any of three switches holds every provider send at preflight (`GLOBAL_PAUSED`): the admin switch (**Pause all outbound** in Jobs and queue, with a reason and a recent sign-in), an `outbound.lock` file in the data folder (written by a restore, or by an operator), or `OUTBOUND_PAUSED=1`. Sends already `SENDING` complete; ingestion, scoring and drafts carry on. Every panel shows a red banner while it holds.',
            '**Workspace automation pause.** Automated sends of that workspace wait (`WORKSPACE_PAUSED`) and its panels show a warning banner; sends a person makes still go.',
            '**Human takeover.** Taking over a conversation stops its automated replies at once, including replies already queued (`HUMAN_TAKEOVER`); **Resume AI** hands it back, and replies queued before the change stay blocked (`MODE_CHANGED`).',
            '**Conversation AI mode.** Off, Draft (suggestions wait for a person) or Auto. Auto is available only while workspace auto-send is on (it is off by default) and only to people with `automation.manage`.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Resuming is covered in [Troubleshooting](/docs/troubleshooting#outbound-paused).',
        },
      ],
    },
  ],
};
