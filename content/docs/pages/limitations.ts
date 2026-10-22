import type { DocPage } from '../format';

export const limitations: DocPage = {
  slug: 'limitations',
  title: 'Limitations',
  summary:
    'What AuraLead AI does not do, what it cannot prove, and the limits of a single-machine deployment, stated plainly so nothing is assumed.',
  appliesTo: ['DEMO', 'LIVE'],
  checked: '2026-10-20',
  sections: [
    {
      id: 'providers-not-live-verified',
      title: 'Provider behavior is not live-verified',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Every provider integration is built against the provider\'s documentation and tested against recorded or documented fixtures, without network access. None has been checked against the real provider yet. The verification status of each one, with its date and evidence, is kept in `docs/integrations.md`.',
        },
        {
          kind: 'list',
          items: [
            'WhatsApp provider error codes and their meaning are kept in one dated table and treated as unverified until checked against live behavior.',
            'Things only the provider decides cannot be shown here: template approval, quality ratings, messaging limits and marketing message caps.',
            'Whether WhatsApp echoes quick-reply payload ids is unverified; when it does not, the button text is matched instead.',
          ],
        },
      ],
    },
    {
      id: 'single-machine',
      title: 'One machine, one database',
      blocks: [
        {
          kind: 'list',
          items: [
            'Each mode is one SQLite file with one writer at a time, shared by one web process and one worker. That suits one business or a small agency on one server; it does not scale out.',
            'Rate limits live in the web process memory, so they hold per process and reset on restart.',
            'Quotation PDFs and the suppression journal are files on the local disk.',
            'A path to PostgreSQL and object storage is described in `docs/deployment.md`; it is not built.',
          ],
        },
      ],
    },
    {
      id: 'accounts',
      title: 'Accounts',
      blocks: [
        {
          kind: 'list',
          items: [
            'No multi-factor authentication.',
            'No self-service "forgot password" email: reset links are issued by an operator.',
            'Accounts exist only by invitation; there is no public sign-up.',
          ],
        },
      ],
    },
    {
      id: 'what-it-cannot-claim',
      title: 'What the app cannot know',
      blocks: [
        {
          kind: 'list',
          items: [
            'A quotation "opened" means a browser kept the page visible for two seconds; it is labelled "Opened (may be automated)" because it is not proof that a person read it.',
            'The lead score is a heuristic fit score from the lead\'s own fields. It is not purchase intent and not consent.',
            'A send whose outcome is unknown stays "Delivery unknown" until the provider reports it or a person decides. It is never resolved by guessing.',
          ],
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'DEMO data is invented and every demo provider is simulated; demo quotations carry "DEMO: not a valid offer".',
        },
      ],
    },
    {
      id: 'not-in-scope',
      title: 'Not in scope',
      blocks: [
        {
          kind: 'list',
          items: [
            'Payments and tax invoices: a quotation says "Quotation, not a tax invoice", and confirmed revenue is not tracked.',
            'More than one tax line (no split into CGST and SGST).',
            'Creating ads, writing WhatsApp templates in the app, calendars and billing.',
            'Automated cold outreach to leads from the Maps extension. Maps leads carry no consent: they can be emailed only by a manual single send after an enabled B2B attestation, and receive WhatsApp templates only after real opt-in evidence is recorded.',
          ],
        },
      ],
    },
    {
      id: 'data-limits',
      title: 'Data handling limits',
      blocks: [
        {
          kind: 'list',
          items: [
            'Erasing a lead does not reach backups taken earlier; retire old backups to complete an erasure.',
            'Erasure keeps the suppression key of the contact on purpose, so an opt-out stays honored.',
            'The Stop keyword list is fixed and short (English and a few Hindi words); other phrasings reach a person as an ordinary message.',
            'The notes on India\'s DPDP Act in [Data and privacy](/docs/data-and-privacy#dpdp) are not legal advice.',
          ],
        },
      ],
    },
    {
      id: 'testing-limits',
      title: 'Testing limits',
      blocks: [
        {
          kind: 'list',
          items: [
            'Browser tests run in Chromium only.',
            'Windows 11 is the main target; the automated suite also runs on Linux.',
          ],
        },
      ],
    },
  ],
};
