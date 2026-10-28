import type { DocPage } from '../format';

/**
 * The Lead Finder (ADR-118, ADR-119, ADR-128). Facts are taken from src/server/services/lead-finder
 * (limits in schemas.ts, the export columns in export.ts, the email rules in email-extract.ts and
 * emails.ts), src/server/adapters/places and the Places expiry in services/leads/ingest.ts.
 * tests/unit/docs/content.test.ts checks every name in a code span against the code.
 */
export const leadFinder: DocPage = {
  slug: 'lead-finder',
  title: 'Lead Finder',
  summary:
    'Find businesses on Google Maps by keyword and location with the Google Places API, filter for those with no website, import them as leads and download a limited Excel file. Covers the 24-hour working copy, attribution, export limits, the No website listed status and the email search.',
  appliesTo: ['DEMO', 'LIVE'],
  checked: '2026-10-23',
  sections: [
    {
      id: 'what-it-does',
      title: 'What the Lead Finder does',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The Lead Finder is a page of the Operator panel, `/dashboard/employee/<ws>/finder` (the first entry of the workspace navigation). A search is a list of keywords and a list of locations: every keyword is searched in every location, so "restaurants" and "dental clinic" in "Indore" and "Bhopal" make four searches. Each search asks Google Places for businesses matching "keyword in location" and returns up to 20, 40 or 60 of them (one to three pages of 20).',
        },
        {
          kind: 'table',
          caption: 'Limits of the Lead Finder',
          head: ['Limit', 'Value'],
          rows: [
            ['Keywords and locations in one search', 'At most 10 of each, so at most 100 searches. A keyword is at most 80 characters, a location at most 120.'],
            ['Results per keyword and location', 'Up to 20, 40 or 60, your choice.'],
            ['Searches running at once', 'Two per workspace. A third is refused with 409 `FINDER_RUN_LIMIT` until one finishes or is cancelled.'],
            ['New searches per hour', '10 per workspace (the `finderRun` limit; a repeated request does not count again).'],
            ['Results imported in one request', '200 (the grid shows 50 results per page).'],
            ['Expired results refreshed in one request', '10, because each refresh is a paid Google request.'],
          ],
        },
        {
          kind: 'table',
          caption: 'Who can do what',
          head: ['Action', 'Capability'],
          rows: [
            ['Open the page and read results', '`leads.read`'],
            ['Start, cancel or refresh a search', '`finder.run`'],
            ['Import results as leads', '`leads.write`'],
            ['Download Excel (and only for a search you started yourself)', '`leads.export`'],
            ['Confirm details of an imported lead', '`leads.write`'],
          ],
        },
        {
          kind: 'paragraph',
          text: 'Without a capability the page still opens and the control shows why it is unavailable. [Roles and panels](/docs/roles-and-panels#capabilities) lists every capability.',
        },
      ],
    },
    {
      id: 'google-places',
      title: 'Google Places and your API key',
      blocks: [
        {
          kind: 'list',
          items: [
            'Each workspace saves its own Google Places API key on the Google Places integration page (`/dashboard/employee/<ws>/integrations/google-places`). It is stored encrypted like every provider credential. The key belongs to a Google Cloud project with billing enabled and the Places API (New) switched on.',
            'Every page of results and every refresh is a paid request on your key. Before you start, the form says how many requests the search can use.',
            'A search may start while the integration is still unverified: the connection test is itself a paid request (one place ID, page size 1), so it runs only when you press it, and Google Places is not part of the hourly integration checks. A key Google rejects ends the search with `PLACES_AUTH`.',
            'The request asks Google only for the fields the page shows and imports: name, business type, phone numbers, website, rating, number of reviews, address and its parts (city, state, PIN code), the Google Maps link and the attributions Google returns. It never asks for reviews or photos, and latitude and longitude are never requested or stored. The Maps link is not stored either; it is rebuilt from the place ID.',
            'Google throttling, server errors and unreachable answers are retried with back-off, up to 8 attempts, and then that search is skipped. A rejected key or a refused API stops the run. A run that skipped a search or stopped ends as "Finished with gaps" when it found places and as "Failed" when it found none. Nothing is ever invented in place of an answer.',
          ],
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'In DEMO there is no key and Google is never contacted. A search reads a deterministic simulated directory that builds businesses from your keywords and locations (24 to 60 per search), about half of them without a website; every row is labelled Simulated. The 24-hour lifecycle below applies to these rows too, so DEMO shows what LIVE does.',
        },
        {
          kind: 'callout',
          tone: 'limit',
          text: 'The request and answer shapes follow Google\'s published reference as read on 23 Oct 2026 and are tested against documented-shape fixtures, not recorded Google traffic. No check has been made against the live service yet. [Limitations](/docs/limitations#providers-not-live-verified) explains what that means.',
        },
      ],
    },
    {
      id: 'results',
      title: 'Results, filters and importing',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The page lists your latest searches with progress, then the results of the selected search: name and business type, phone, website (or the "No website listed" chip), rating and reviews, address, city and PIN code, a link to the business on Google Maps and, when you asked for them, the email addresses found. The filters are **No website listed**, **Has phone** and **Not imported**, each with its count.',
        },
        {
          kind: 'list',
          items: [
            '**Import selected** turns the chosen results into leads through the one ingestion path every source uses: duplicates are recognised by place ID and by phone number across all sources, possible duplicates go to merge review, and each new lead is scored and enters the workspace pipeline. Results that were already imported, and results whose details expired, are skipped and counted.',
            'The place ID is kept on the lead. If the email search found addresses, the best one (a role address first) goes with the lead as its email. Importing never records consent.',
            'A search can be cancelled while it is queued or running. The page refreshes by itself until the searches and their email checks are done.',
          ],
        },
      ],
    },
    {
      id: 'working-copy',
      title: 'The 24-hour working copy',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Google Maps content is a working copy: it is kept for 24 hours after it was fetched, long enough to filter, select and import, and then removed. The purge job (`leadFinder.purge`) runs at the end of the hour in which the copy expires, and expired content is never shown even if the job has not run yet.',
        },
        {
          kind: 'table',
          caption: 'What a finder result keeps',
          head: ['Removed after 24 hours', 'Kept'],
          rows: [
            [
              'Name, business type, phone numbers, website, rating, review count, address, city, state, PIN code and the attributions',
              'The place ID, the keyword and location it was found with, whether the listing had a website, the emails found on the business\'s own website with their source pages, and the lead it was imported as',
            ],
          ],
        },
        {
          kind: 'list',
          items: [
            'An expired row reads "Details expired" and offers **Refresh details**: one paid Place Details request per row (up to 10 at a time, `finder.run` needed). A refresh replaces the whole copy, including attributions Google no longer sends.',
            'After a person\'s data was erased on request (see [Data and privacy](/docs/data-and-privacy#erasure)) their place reads "Details removed on request" and a refresh never fetches it again.',
            'The leads you imported keep their own copy of the Places fields for 30 days; see [Places fields on a lead](#places-leads).',
          ],
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'The presentation workspace Codecraft Web Studio is seeded with a finished search whose results stay available for 365 days (no purge job is queued for it), so the details are there whenever it is opened. Searches you start yourself keep the 24-hour rule.',
        },
      ],
    },
    {
      id: 'attribution',
      title: 'Attribution',
      blocks: [
        {
          kind: 'list',
          items: [
            'In LIVE, "Google Maps" and the attributions Google returned are shown wherever Places content appears: in the finder grid and, for the fields that came from Places, on the operator lead page, the client lead page and the Leads sheet. With them goes the line "Results from Google Maps. Use is subject to the Google Maps Additional Terms of Service and the Google Privacy Policy.", linked to both documents.',
            'Attributions are kept only while the finder still holds the content.',
          ],
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'Simulated listings are not Google content. They carry the Simulated chip and no Google attribution.',
        },
        {
          kind: 'callout',
          tone: 'warning',
          text: 'The 24-hour copy, the attribution and the export limits reduce risk. They are not a licence: you remain responsible for the Google Maps Platform terms that apply to your own key.',
        },
      ],
    },
    {
      id: 'places-leads',
      title: 'Places fields on a lead (30 days)',
      blocks: [
        {
          kind: 'list',
          items: [
            'An imported lead keeps its place ID. The fields that came from Places (phone and alternate phones, rating, review count, address, PIN code and business type) carry an expiry of 30 days after the import.',
            'On that day `leads.placesExpire` clears those fields and deletes the lead\'s phone contact keys, unless the contact was confirmed. The name, city, website and place ID stay.',
            'A contact counts as confirmed when a WhatsApp opt-in is recorded for the lead (see [Reach out and hand over](/docs/reach-out-and-handoff#record-opt-in)) or when an operator presses **Confirm details** on the lead (audited; `leads.write`), or when the customer writes to you on WhatsApp from the number (a message that is not a Stop). A confirmed lead keeps its details. A lead that was handed over, has a quotation or has a conversation the customer has written in is also left alone by the sweep.',
            'The source record kept for each imported listing holds the place ID and the names of its fields only, never the values; the score reasons are recalculated when the fields expire, so "Rated 4.5 of 5" does not outlive the rating.',
            'A lead export writes the lead\'s columns as stored, so a Places lead\'s phone, address and rating are in it until they expire.',
          ],
        },
        {
          kind: 'callout',
          tone: 'limit',
          text: 'Like the 24-hour copy, this reduces risk and is not a licence.',
        },
      ],
    },
    {
      id: 'export',
      title: 'Download Excel',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Download Excel gives the results of one search as an .xlsx workbook (sheet "Lead finder", up to 6,000 rows). It is built when you ask and is never stored on the server. Only the person who started the search can download it, `leads.export` is needed, and each download is audited as `finder.export` with its row count and column set, never its content. The workbook never contains a formula: every value is text or a number.',
        },
        {
          kind: 'table',
          caption: 'Columns of the Excel file in LIVE',
          head: ['Column', 'Holds'],
          rows: [
            ['Place ID', 'Google\'s identifier of the business.'],
            ['Google Maps link', 'A link to the business on Google Maps, built from the place ID.'],
            ['Keyword and Location', 'What the business was found with.'],
            ['Imported, Lead ID and Stage', 'Your own columns: whether it was imported, as which lead, and the lead\'s sales stage.'],
            ['Website emails and Email source pages', 'Addresses found on the business\'s own website, and the pages they came from.'],
          ],
        },
        {
          kind: 'paragraph',
          text: 'Names, phone numbers, addresses, websites, ratings and review counts are never written to the LIVE file; they stay on screen for 24 hours only. To keep a business, import it as a lead.',
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'A DEMO file holds the full simulated columns (name, phone, website, rating, address and the rest), marked Simulated, and no Maps link because a simulated place ID has no map.',
        },
        {
          kind: 'paragraph',
          text: 'The Leads page has its own export, in CSV or Excel, for the leads you already hold: see [Import and export leads](/docs/import-and-export#lead-export).',
        },
      ],
    },
    {
      id: 'no-website-listed',
      title: 'No website listed',
      blocks: [
        {
          kind: 'list',
          items: [
            'When Google\'s listing for a business has no website, the lead\'s website status is **No website listed** (`NOT_LISTED`). Only the finder import sets it, and only when the listing says so; an unknown website stays "Not checked".',
            'It is evidence from the listing, which may be out of date. **No website**, the status a person sets after checking, is the stronger statement. The website check never changes a "No website listed" lead, because there is no address to open.',
            'The score treats it as a known input. In a workspace whose scoring prefers businesses without a website (`websitePreference` set to ABSENT) it earns the full website points, like a verified absence; with the default preference it is a known zero. [From lead to quotation](/docs/lead-to-quote-workflow#scoring) explains the score.',
          ],
        },
      ],
    },
    {
      id: 'email-search',
      title: 'Looking for email addresses',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Google Places gives no email address. The search form can look for them on each listed website: the checkbox **Look for email addresses on each listed website** is off by default, and you may list addresses or domains that must never be kept. It runs in the background after the search, three websites per job.',
        },
        {
          kind: 'list',
          items: [
            'For each website the crawler reads robots.txt first (the rules written for `auraleadbot`, else those for `*`; the longest matching rule wins), then the home page and at most two contact pages of the same website. It makes one request at a time to a website and gives each page at most 8 seconds and 1 MB. It identifies itself as `AuraLeadBot/1.0` with a link to the [AuraLeadBot page](/docs/bot).',
            'A website that disallows the bot is not read ("Not checked: the site\'s robots.txt disallows it"). If robots.txt answers with a server error or asks the bot to slow down, everything is assumed disallowed. If the website cannot be reached at all, the result reads "Website could not be read" and nothing else is requested from it.',
            'An address is kept with the page it came from and a label: `ROLE` (info, sales), `PERSONAL` or `FREEMAIL`. At most 10 are kept per business. Placeholder addresses, file names that look like addresses and everything on your blocklist (an address, or a domain and its subdomains) are dropped.',
            'A result without a listed website reads "No website listed" and is not crawled.',
          ],
        },
        {
          kind: 'callout',
          tone: 'note',
          text: 'Finding an address is not consent. Email needs an email opt-in or an enabled B2B attestation, and an attested contact can only receive a manual single send. See [Messaging rules](/docs/messaging-rules#consent).',
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'In DEMO no website is contacted: the addresses are invented, on the reserved domain demo-leads.in.',
        },
      ],
    },
    {
      id: 'reaching-places-leads',
      title: 'Reaching a lead from Places',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A business found on a map has not asked to be messaged. Places leads therefore carry no WhatsApp opt-in: a template send to them, single or in bulk, is skipped with `NO_WHATSAPP_OPT_IN` and never attempted. They can be called, emailed after an enabled B2B attestation (a manual single send), or reached on WhatsApp after you record a real opt-in, or after they write to you, for example through your click-to-chat link. [Reach out and hand over](/docs/reach-out-and-handoff) describes both tools.',
        },
      ],
    },
  ],
};
