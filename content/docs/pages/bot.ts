import type { DocPage } from '../format';

/**
 * The page the crawler's User-Agent points to (`AuraLeadBot/1.0 (+<app origin>/docs/bot)`, set in
 * services/enrichment/website.ts and jobs/handlers/lead-finder-emails.ts). A site owner who finds
 * the bot in a log reads this page: it must stay true to the crawlers, so it states only what the
 * code enforces (robots.txt rules in services/lead-finder/email-extract.ts, limits in
 * services/lead-finder/emails.ts, the fetch guard in security/safe-fetch.ts).
 */
export const bot: DocPage = {
  slug: 'bot',
  title: 'AuraLeadBot',
  summary: 'What the AuraLeadBot crawler reads on a business website, how it behaves, and how a website owner stops it with robots.txt.',
  appliesTo: ['DEMO', 'LIVE'],
  checked: '2026-10-23',
  sections: [
    {
      id: 'what-it-is',
      title: 'What AuraLeadBot is',
      blocks: [
        {
          kind: 'paragraph',
          text: 'AuraLeadBot is the name this application sends when it reads a public business website for the workspace that asked it to. Its User-Agent is `AuraLeadBot/1.0` followed by the address of this page. It reads only pages that any visitor can open without signing in.',
        },
      ],
    },
    {
      id: 'when-it-visits',
      title: 'When it visits a website',
      blocks: [
        {
          kind: 'list',
          items: [
            '**To check a lead\'s website.** When a business has a website address on record, the app opens that address to see whether it answers and keeps the visible text of the page (at most 8,000 characters) to help judge whether the business needs a website. The text is stored as untrusted data and never treated as instructions.',
            '**To find contact email addresses, only when the person running a Lead Finder search switches it on for that search.** It is off by default. The bot then reads the robots.txt file, the home page and at most two contact pages of the same website.',
          ],
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'In DEMO mode no website is contacted at all. The email addresses a DEMO search shows are invented.',
        },
      ],
    },
    {
      id: 'how-it-behaves',
      title: 'How it behaves',
      blocks: [
        {
          kind: 'list',
          items: [
            '**Email search:** it reads robots.txt first. It follows the rules written for `auraleadbot`, or for `*` when there is no group for it; the longest matching rule wins, and an empty Disallow allows everything. A website that disallows the bot is not read. If robots.txt answers with a server error or asks the bot to slow down, the bot assumes everything is disallowed and reads nothing.',
            '**Website check:** it opens the one address on record, once, as a visitor would. It does not look for other pages and does not read robots.txt.',
            'It makes one request at a time to a website, and gives each page at most 8 seconds and 1 MB.',
            'It accepts only web pages (text/html) and plain text. It sends no cookies, signs in nowhere and submits no forms.',
            'It follows at most three redirects, and checks the destination of each one. It reads only addresses on the public internet; a link to a private or internal address is refused.',
          ],
        },
      ],
    },
    {
      id: 'stop-the-bot',
      title: 'Stopping the bot',
      blocks: [
        {
          kind: 'paragraph',
          text: 'To keep the email search away from your website, add these two lines to its robots.txt file. The bot reads that file before any other page and stops there.',
        },
        {
          kind: 'code',
          language: 'text',
          caption: 'robots.txt: do not let AuraLeadBot read any page',
          code: 'User-agent: auraleadbot\nDisallow: /',
        },
        {
          kind: 'paragraph',
          text: 'To keep it away from part of the site only, disallow just that path. A rule for `*` applies to the bot as well. The single website check does not read robots.txt: to stop it, block the User-Agent `AuraLeadBot/1.0` at your server, or ask the business that holds your address to remove it.',
        },
      ],
    },
    {
      id: 'what-is-kept',
      title: 'What is kept',
      blocks: [
        {
          kind: 'list',
          items: [
            'An email address found on a page is kept with the address of the page it came from and a label: a role mailbox such as info or sales, a personal address, or one from a free mail provider. Placeholder addresses and the addresses the person excluded for that search are dropped.',
            'Nothing is sent to an address only because the bot found it. Every message goes through the checks in [Messaging rules](/docs/messaging-rules).',
            'See [Data and privacy](/docs/data-and-privacy) for how long data is kept and how a business erases a person\'s data. To have your address removed, write to the business whose workspace found it.',
          ],
        },
      ],
    },
  ],
};
