import type { DocPage } from '../format';

/**
 * The inbox in both panels and the automatic replies (ADR-63, ADR-121, ADR-122, ADR-130). Facts are
 * taken from src/server/services/ai/reply-guard.ts (intents, fixed replies, disclosure),
 * conversation-reply.ts, src/server/services/messaging/conversations.ts (cap, window, escalation)
 * and inbox.ts, and src/components/inbox.
 */
export const inboxAndAiReplies: DocPage = {
  slug: 'inbox-and-ai-replies',
  title: 'Inbox and automatic replies',
  summary:
    'The WhatsApp-style inbox in the Client and Operator panels, the Off, Draft and Auto modes, what the AI may answer inside the 24-hour window, what it never answers, when a thread goes to a person, the disclosure line, the cap of four automatic replies and the Automatic sending switch.',
  appliesTo: ['DEMO', 'LIVE'],
  checked: '2026-10-23',
  sections: [
    {
      id: 'inbox',
      title: 'The inbox',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Both panels have an inbox: `/dashboard/user/inbox` for workspace users and `/dashboard/employee/<ws>/inbox` for operators of an assigned workspace. Both need `leads.read` and show the same conversations with the same rules.',
        },
        {
          kind: 'list',
          items: [
            'The thread list shows the customer\'s initials, the last message, its time and the window badge ("Free-form until 14:30", or "Window closed"). Badges say what needs attention: **Needs you**, **Escalated**, **Handed over**. The filters **All**, **Needs you** and **Handed over** carry their counts.',
            'A conversation reads like WhatsApp: bubbles, day separators, and templates shown with their values filled in. Every outgoing message has a delivery mark that is a tick and a word (Queued, Sent, Delivered, Read, Failed, Delivery unknown, Not sent), never a tick alone. The name of the lead, its stage and a link to the lead page are at the top.',
            'Automatic replies say how they were written: by the AI model, by the guard\'s own catalog answer (`reply-guard`) or by a person. A message a person wrote is labelled as theirs.',
            'Delivered and Read marks come only from the provider\'s status webhooks; the app never infers them.',
          ],
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'In DEMO the inbox has a customer simulator (**Simulate customer message**, with a **Customer\'s phone (Simulated)** line), and a DEMO send gets simulated Delivered and Read marks: Delivered 2 seconds after the send settles and Read 4 seconds later (the `wa.demoStatus` job). They are labelled simulated and nothing leaves the app.',
        },
      ],
    },
    {
      id: 'writing',
      title: 'Writing a reply',
      blocks: [
        {
          kind: 'list',
          items: [
            'While the 24-hour window is open the composer sends free-form text and counts down to the closing time. Once it has closed, only an approved template can start the conversation again; the composer switches to templates by itself and the check runs once more at send. See [Messaging rules](/docs/messaging-rules#window).',
            'A template\'s values come from the lead and the workspace (first name, name, city, business category, business name) and are resolved again on the server at send. A missing value refuses the send with `TEMPLATE_VARIABLES_MISSING`; a template this app cannot send (a header variable, for example) is refused with `TEMPLATE_NOT_SENDABLE`.',
            'Sending from the composer needs `dispatch.send` together with `approvals.decide`, and the same eligibility check as every other send; saving a reply for review needs `leads.write`. A person\'s message in the composer clears a thread\'s "Needs you" mark.',
          ],
        },
      ],
    },
    {
      id: 'modes',
      title: 'Off, Draft and Auto',
      blocks: [
        {
          kind: 'table',
          caption: 'The AI mode of a conversation',
          head: ['Mode', 'What happens to an incoming message'],
          rows: [
            ['Off', 'No reply is prepared.'],
            ['Draft for approval', 'The AI prepares a reply and a person approves each one before it is sent.'],
            ['Auto', 'A safe reply is sent automatically after the same checks as any send. Complaints, requests for a person and anything unclear go to a person.'],
          ],
        },
        {
          kind: 'list',
          items: [
            'Changing a thread\'s mode, taking it over and resuming it need `leads.write`. Auto also needs `automation.manage` and **Automatic sending** switched on (below). Every change asks for confirmation and is audited.',
            '**Take over** stops the AI on that thread at once, including replies already queued; **Resume AI** hands it back. After a lead is handed over to the client, the operator can do none of this; see [Reach out and hand over](/docs/reach-out-and-handoff#after-handoff).',
          ],
        },
      ],
    },
    {
      id: 'automatic-sending',
      title: 'The Automatic sending switch',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The switch in the inbox header is the workspace\'s auto-send setting. It is labelled "Automatic sending: AI replies and automated pipeline sends" because one switch controls both: replies in Auto conversations and the pipeline\'s policy-approved first messages. It is off by default and needs `automation.manage`; turning it on asks for confirmation naming the workspace, and each change is audited.',
        },
        {
          kind: 'list',
          items: [
            'On: Auto conversations answer without a person approving each reply. Every send still passes consent, opt-out and window checks, and a person can take over any thread.',
            'Off: automated replies and automated pipeline sends stop. Anything already queued is held at send (`AUTO_SEND_DISABLED`), and an Auto conversation drafts its next reply for approval instead.',
          ],
        },
      ],
    },
    {
      id: 'what-ai-answers',
      title: 'What the AI may answer',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The AI never chats freely. The app is built on the understanding that WhatsApp\'s business terms of 2026 do not allow a general-purpose assistant, so a reply may only say what the business already approved. Every incoming text first goes through fixed rules that put it in exactly one of seven intents, in this order: stop, complaint, request for a person, call request, quote or price request, service question, and out of scope. Anything the rules do not recognise is out of scope, so doubt escalates instead of being answered. Only a service question may reach a model.',
        },
        {
          kind: 'table',
          caption: 'What happens for each kind of message',
          head: ['Customer\'s message', 'Reply', 'Thread'],
          rows: [
            [
              'A service question (`service_faq`): what the business does, what is included, how long it takes, or a greeting',
              'An answer built only from the workspace\'s service list: name, description and typical timeline, never a price. Written by the workspace\'s AI integration, or by the guard\'s own catalog answer when there is none.',
              'Stays in Auto.',
            ],
            [
              'A price or quote request (`quote_request`)',
              'A fixed reply: a member of the team will prepare the quotation and share it here. No amount is ever quoted.',
              'Stays in Auto; marked Needs you.',
            ],
            [
              'A call request (`call_request`)',
              'A fixed reply: a member of the team will call back. It may carry the workspace\'s https booking link.',
              'Stays in Auto; marked Needs you.',
            ],
            [
              'A complaint, a request for a person (`human_request`) or anything out of scope',
              'A fixed reply saying a member of the team will reply personally.',
              'Moves from Auto to Draft; marked Needs you.',
            ],
            [
              'A Stop inside a longer message',
              'No reply. (A message that is only a Stop keyword is applied at once by the webhook, not by the AI.)',
              'Marked Needs you so a person records the opt-out.',
            ],
          ],
        },
        {
          kind: 'list',
          items: [
            'The model sees the workspace\'s service facts and the last 12 messages of the thread, passed as delimited untrusted data, and must answer in a strict format that includes its own judgement of the intent and whether to escalate. The text then runs through the output policy: an amount, a link, a phone number, an email address or payment wording is never sent.',
            'If the model reports another intent, asks to escalate, breaks the output policy or fails after its one repair attempt, the fixed hand-over reply is sent instead ("a member of our team will reply to you here"), labelled `reply-guard` and never with the model\'s name, and the thread is escalated.',
            'A Draft conversation uses the same logic: the suggested reply for a service question is written the same way, and a person approves it.',
            'In LIVE a workspace without an AI integration keeps the guard\'s own catalog answer for service questions. The app never switches to another generator behind your back.',
            'A workspace with no service list cannot answer service questions at all (`NO_APPROVED_FACTS`): the thread goes to a person.',
          ],
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'In DEMO the service answer comes from a local template generator that reads the workspace\'s service list and the question, labelled "Local template". No model is called.',
        },
      ],
    },
    {
      id: 'window-disclosure-cap',
      title: 'The window, the disclosure and the cap',
      blocks: [
        {
          kind: 'list',
          items: [
            '**Only inside the 24-hour window.** In Auto and in Draft, no reply and no draft is made once the window has closed (audited as `reply.not_generated` with the reason `WINDOW_CLOSED`), and no model is called. The model is also skipped when the reply could not be sent anyway, for example because the contact opted out or has no consent.',
            '**Disclosure.** The first automatic reply in each window begins with the line "<Business>\'s automated assistant. Reply HUMAN to talk to a person." HUMAN matches the request-for-a-person rule, so the customer\'s answer reaches a person. A window starts at the oldest message of the unbroken run of customer messages that each arrived less than 24 hours after the one before. Drafts a person approves are not automatic and carry no disclosure.',
            '**Cap.** After 4 automatic replies in a row, with no message from a person between them, the next reply is not sent: the thread moves to Draft and waits for approval (reason `REPLY_CAP`).',
            '**Handed over.** Once a lead has been handed over to the client, no automatic reply is made; the check is repeated at the moment of sending.',
          ],
        },
      ],
    },
    {
      id: 'needs-you',
      title: 'Needs you',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A thread counts under **Needs you** while something waits for a person: an escalation nobody has answered yet, a draft to approve, a call request or a failed delivery. An escalation is recorded on the thread and in the audit log (`conversation.escalated`) with its reason. It clears when a person sends a message, changes the mode, resumes the AI or approves a send after it.',
        },
        {
          kind: 'table',
          caption: 'Why a thread escalated',
          head: ['Reason', 'Meaning'],
          rows: [
            ['`complaint`, `human_request`, `out_of_scope`, `stop`', 'The message itself called for a person.'],
            ['`quote_request`, `call_request`', 'Prices and call times come from a person.'],
            ['`OUTPUT_POLICY`', 'The answer would have contained an amount, a link, a contact or payment wording.'],
            ['`NO_APPROVED_FACTS`', 'The workspace has no service list to answer from.'],
            ['`MODEL_ESCALATED`', 'The model reported another intent or asked for a person.'],
            ['`AI_FAILED`', 'The model call failed after its retries.'],
            ['`REPLY_CAP`', 'Four automatic replies were sent in a row.'],
          ],
        },
        {
          kind: 'paragraph',
          text: 'The read model also keeps a handed-over thread out of the operator\'s Needs you: it belongs to the client, whose own inbox lists it.',
        },
      ],
    },
  ],
};
