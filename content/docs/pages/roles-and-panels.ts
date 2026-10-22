import type { DocPage } from '../format';

export const rolesAndPanels: DocPage = {
  slug: 'roles-and-panels',
  title: 'Roles and panels',
  summary:
    'Who can do what: workspace owners and members in the Client panel, employees with per-workspace capabilities and discount caps in the Operator panel, and super admins in Platform admin.',
  appliesTo: ['DEMO', 'LIVE'],
  checked: '2026-10-20',
  sections: [
    {
      id: 'roles',
      title: 'Three kinds of account',
      blocks: [
        {
          kind: 'table',
          caption: 'Roles',
          head: ['Role', 'Panel', 'Reach'],
          rows: [
            ['Client user (`USER`)', 'Client panel, `/dashboard/user`', 'One workspace, through a membership as `OWNER` or `MEMBER`.'],
            ['Employee (`EMPLOYEE`)', 'Operator panel, `/dashboard/employee`', 'Each workspace they are actively assigned to, with the capabilities and the discount cap of that assignment.'],
            ['Super admin (`SUPER_ADMIN`)', 'Platform admin, `/dashboard/admin`', 'Platform health, jobs and webhooks. Workspace data only through an audited elevation.'],
          ],
        },
        {
          kind: 'paragraph',
          text: 'Each role opens only its own panel. Another panel\'s address, or any record of a workspace you cannot reach, answers 404, as if it did not exist. Inside your own workspace, an action your capabilities do not allow answers 403 and the control shows why it is unavailable. [How access is decided](#access-rules) has the details.',
        },
      ],
    },
    {
      id: 'capabilities',
      title: 'Capabilities',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Actions are allowed by capability. A workspace `OWNER` holds every capability in their own workspace. A `MEMBER` holds the working set marked below. An employee holds exactly the capabilities listed on each assignment. The full list of capability names is in `src/lib/domain/enums.ts`; these are the ones the current screens and requests check:',
        },
        {
          kind: 'table',
          caption: 'Capabilities checked today',
          head: ['Capability', 'Allows', 'Member'],
          rows: [
            ['`leads.read`', 'See leads, the lead console, conversations and the approval queue.', 'Yes'],
            ['`leads.write`', 'Run DEMO source simulations, take over or resume a conversation, change its AI mode, save a reply for review.', 'Yes'],
            ['`drafts.generate`', '**Generate draft** and **Generate with local template**.', 'Yes'],
            ['`quotes.edit`', 'Create, revise and cancel quotations.', 'Yes'],
            ['`dispatch.send`', 'Create and revoke share links, **Copy link** and **Mark as sent manually**; together with `approvals.decide`, send from the composer or the approval queue.', 'Yes'],
            ['`approvals.decide`', 'Approve or reject quotations and message drafts.', 'No'],
            ['`pricing.override`', 'Edit services, prices, tax and discount settings, and give a discount above your own cap (still within the workspace and service limits).', 'No'],
            ['`automation.manage`', 'Set a conversation to AI mode Auto (only while the workspace has auto-send on).', 'No'],
          ],
        },
      ],
    },
    {
      id: 'discount-caps',
      title: 'Discount limits and caps',
      blocks: [
        {
          kind: 'list',
          items: [
            'Every quotation discount must stay within the workspace maximum and the maximum of every service on the quotation. Above it the quotation is refused for everyone (`DISCOUNT_OVER_LIMIT`).',
            'An employee also has a personal cap: the lower of the assignment cap and the workspace maximum. A discount above it, without `pricing.override`, is refused with 403 and recorded in the audit log as denied.',
            'A workspace owner has no personal cap; the workspace and service limits still apply.',
          ],
        },
      ],
    },
    {
      id: 'client-panel',
      title: 'Client panel (workspace users)',
      blocks: [
        {
          kind: 'table',
          caption: 'Client panel pages',
          head: ['Page', 'Address', 'What it does'],
          rows: [
            ['Command center', '`/dashboard/user`', 'The workspace at a glance: the priced catalog, quotation settings, the active scoring and pipeline versions, and the team.'],
            ['Pricing', '`/dashboard/user/pricing`', 'Services and the active price list, tax, discount limits, timelines and the version history. A price change makes a new price list version; issued quotations keep their own copy.'],
            ['Quotations', '`/dashboard/user/quotations`', 'Every quotation and its versions; a new quotation from a lead and its draft proposal; approve, revise and cancel; share links and hand-over; the state timeline.'],
            ['Inbox', '`/dashboard/user/inbox`', 'WhatsApp and email conversations, the reply composer with its eligibility line, takeover and the conversation AI mode. In DEMO it can also simulate a customer message.'],
          ],
        },
      ],
    },
    {
      id: 'operator-panel',
      title: 'Operator panel (employees)',
      blocks: [
        {
          kind: 'table',
          caption: 'Operator panel pages',
          head: ['Page', 'Address', 'What it does'],
          rows: [
            ['Assignments', '`/dashboard/employee`', 'One card per active assignment: the workspace, the granted capabilities and the discount cap, with links to its lead console and approval queue.'],
            ['Approvals', '`/dashboard/employee/approvals`', 'Pending approvals of every assigned workspace, one section each.'],
            ['Lead console', '`/dashboard/employee/<ws>/leads`', 'Leads of one workspace with source, score and stage; recent source deliveries; in DEMO the source simulators.'],
            ['Lead', '`/dashboard/employee/<ws>/leads/<leadId>`', 'Contact facts, the score breakdown, the pipeline stages, the draft, and its quotations with approve and PDF download.'],
            ['Approval queue', '`/dashboard/employee/<ws>/approvals`', 'Items waiting for a decision; each item shows the version diff and the per-channel eligibility, and offers approve, approve and send, edit or reject with a reason.'],
          ],
        },
        {
          kind: 'paragraph',
          text: 'The workspace in the address is checked against your active assignments on every request; an address for a workspace you are not assigned to answers 404.',
        },
      ],
    },
    {
      id: 'platform-admin',
      title: 'Platform admin (super admins)',
      blocks: [
        {
          kind: 'table',
          caption: 'Platform admin pages',
          head: ['Page', 'Address', 'What it does'],
          rows: [
            ['Global metrics', '`/dashboard/admin`', 'Worker liveness, the outbound delivery state with its three switches, and account counts. Counts only, no tenant records.'],
            ['Jobs and queue', '`/dashboard/admin/jobs`', 'Queue health, jobs by status, the job inspector (redacted payload, attempts, correlation timeline), cancel, safe retry, resolving "Delivery unknown" sends, and the global outbound pause.'],
            ['Webhooks', '`/dashboard/admin/webhooks`', 'Received webhook deliveries with their redacted inspector view and processing state.'],
          ],
        },
        {
          kind: 'list',
          items: [
            'Every action on a job and the outbound pause needs a typed reason and a sign-in within the last 15 minutes, and is audited as a cross-workspace action. Acting on a workspace\'s job first records an `admin.elevate` audit event.',
            'Inspector views show redacted payloads only; the encrypted processing copy of a webhook is never decrypted for display.',
            'Super admin sessions end after 12 hours.',
          ],
        },
      ],
    },
    {
      id: 'demo-only',
      title: 'DEMO only',
      appliesTo: ['DEMO'],
      blocks: [
        {
          kind: 'paragraph',
          text: 'The seeded identities on `/login`, the floating **Demo role** switcher, the source simulators and the customer-message simulator exist only in a DEMO process. Their routes (`/api/demo/*` and `/api/webhooks/whatsapp/simulate`) answer 404 in LIVE, and a LIVE build does not contain the switcher at all.',
        },
      ],
    },
    {
      id: 'access-rules',
      title: 'How access is decided',
      blocks: [
        {
          kind: 'list',
          items: [
            'Every page and every request is checked on the server. A page without a session redirects to `/login`; a request without one answers 401.',
            'The workspace comes from your session or from the assignment named in the address, never from the request body: a `workspaceId`, `userId` or `role` sent by the browser that differs from the server\'s answer is a 404.',
            'Records of another workspace answer 404, and ids inside a request (a service, quotation, lead or conversation) must belong to your workspace, or the request is refused.',
            'Changing a person\'s role or account status signs them out everywhere, so their next request is decided with the new privileges.',
          ],
        },
      ],
    },
  ],
};
