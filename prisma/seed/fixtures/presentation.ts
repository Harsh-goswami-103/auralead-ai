/**
 * Presentation pack for DEMO (ADR-126, plan §5 F6): the data of the sixth workspace,
 * `codecraft-web` (Codecraft Web Studio, Indore), a web-development studio that is the client of
 * the lead-gen story (Find, Chat, Hand over, Quote). Pure data and pure builders; the rows are
 * written by `insertPresentation` (insert-presentation.ts).
 *
 * - One finished, simulated Lead Finder run ("restaurants, dental clinic, salon" x "Indore,
 *   Bhopal"): 40 places, exactly half without a website listed, 3 without a phone. The places are
 *   fictitious and deterministic (keyword- and location-aware names, localities, PIN codes and
 *   Indian mobile numbers from src/lib/demo/contacts.ts); they are not Google content and carry no
 *   Google attribution. Every row is flagged simulated.
 * - 12 of them imported as GOOGLE_PLACES leads (10 with no website listed), 3 of those with a
 *   recorded WhatsApp opt-in (notice + method, ADR-125), two chats with an open 24-hour window
 *   (one in automatic replies, one escalated to a person) and one lead handed over to the client.
 * - Times are minutes or hours before the seed anchor; `demo:refresh` re-bases every one of them
 *   (prisma/seed/rebase.ts), so windows stay open and "handed over 3 hours ago" stays true. JSON
 *   columns carry no timestamps.
 *
 * Every name, number and address here is invented. DEMO makes zero outbound calls.
 */
import { demoMobile, seedHash } from '../../../src/lib/demo/contacts';
import type { TemplateVariableSource } from '../../../src/lib/domain/whatsapp-templates';

export const PRESENTATION_SLUG = 'codecraft-web';
export const PRESENTATION_BUSINESS = 'Codecraft Web Studio';
/** The client persona (identities.ts key): Aarav Mehta, OWNER of codecraft-web. */
export const PRESENTATION_OWNER = 'client';
/** The operator persona (identities.ts key) that found, messaged and handed over the leads. */
export const PRESENTATION_OPERATOR = 'employee';

/** ADR-125: the notice prefilled when an opt-in is recorded; it names the business and WhatsApp. */
export const PRESENTATION_OPT_IN_NOTICE =
  'Codecraft Web Studio would like to send you WhatsApp messages about websites, online stores and SEO for your business. You can reply STOP at any time to stop these messages.';
export const PRESENTATION_PRIVACY_CONTACT = 'privacy@codecraft.example.com';

/**
 * Scoring v1 of codecraft-web: the studio sells websites, so a business whose listing has no
 * website earns the website points (websitePreference ABSENT, ADR-119). Weights sum to 100.
 */
export const CODECRAFT_SCORING_V1 = {
  schemaVersion: 1,
  weights: {
    phonePresent: 20,
    emailPresent: 5,
    websiteStatus: 30,
    rating: 15,
    reviewCount: 10,
    categoryMatch: 15,
    sourceIntent: 5,
  },
  notes: 'Web-development fit: a business with no website listed scores higher. A heuristic, not a measure of buying intent or consent.',
  targetCategories: ['restaurant', 'clinic', 'salon', 'gym', 'boutique', 'coaching'],
  websitePreference: 'ABSENT',
  reviewCountTarget: 200,
} as const;

// ---- Lead Finder run --------------------------------------------------------------------------

export type FinderLocation = 'Indore' | 'Bhopal';
export type FinderKeyword = 'restaurants' | 'dental clinic' | 'salon';

/**
 * One keyword x location cell: `pattern` has one letter per result in provider order, `N` for a
 * listing with no website and `W` for one with a website. Exactly 20 of the 40 are `N`.
 */
type CellFixture = { keyword: FinderKeyword; location: FinderLocation; pattern: string; imported: readonly number[]; noPhone?: readonly number[] };

export const FINDER_RUN_FIXTURE = {
  key: `${PRESENTATION_SLUG}:finder-1`,
  requestKey: 'seed-codecraft-finder-0001',
  keywords: ['restaurants', 'dental clinic', 'salon'] as const satisfies readonly FinderKeyword[],
  locations: ['Indore', 'Bhopal'] as const satisfies readonly FinderLocation[],
  maxPerQuery: 20,
  /** The run started 12 hours before the anchor and searched one cell every 20 seconds. */
  startedMinutesAgo: 12 * 60,
  cellSeconds: 20,
  /** The 12 places were imported 30 minutes after the run. */
  importedMinutesAgo: 11 * 60 + 30,
  cells: [
    { keyword: 'restaurants', location: 'Indore', pattern: 'NNWNWWNW', imported: [0, 1], noPhone: [6] },
    { keyword: 'restaurants', location: 'Bhopal', pattern: 'NWNWNW', imported: [0, 2] },
    { keyword: 'dental clinic', location: 'Indore', pattern: 'NWWNNWN', imported: [0, 1] },
    { keyword: 'dental clinic', location: 'Bhopal', pattern: 'WNNWNW', imported: [1, 2], noPhone: [5] },
    { keyword: 'salon', location: 'Indore', pattern: 'NNWNWNW', imported: [0, 1], noPhone: [6] },
    { keyword: 'salon', location: 'Bhopal', pattern: 'NWWNWW', imported: [0, 1] },
  ] as const satisfies readonly CellFixture[],
} as const;

/** Places content is a 24-hour working copy (ADR-118 (a)); imported Places fields last 30 days (ADR-118 (d)). */
export const FINDER_CONTENT_TTL_MINUTES = 24 * 60;
export const PLACES_LEAD_TTL_DAYS = 30;

const STATE = 'Madhya Pradesh';

const LOCALITIES: Readonly<Record<FinderLocation, ReadonlyArray<{ name: string; pincode: string }>>> = {
  Indore: [
    { name: 'Vijay Nagar', pincode: '452010' },
    { name: 'Palasia', pincode: '452001' },
    { name: 'Rajwada', pincode: '452004' },
    { name: 'Bhawarkua', pincode: '452014' },
    { name: 'Sapna Sangeeta Road', pincode: '452001' },
    { name: 'Annapurna Road', pincode: '452009' },
    { name: 'Scheme No. 54', pincode: '452010' },
    { name: 'Khajrana', pincode: '452016' },
  ],
  Bhopal: [
    { name: 'MP Nagar', pincode: '462011' },
    { name: 'Arera Colony', pincode: '462016' },
    { name: 'New Market', pincode: '462003' },
    { name: 'Kolar Road', pincode: '462042' },
    { name: 'Bairagarh', pincode: '462030' },
    { name: 'Indrapuri', pincode: '462022' },
    { name: 'Shahpura', pincode: '462039' },
  ],
};

/** Per keyword: the category a listing shows and invented business names (Indore cells first, then Bhopal). */
const KINDS: Readonly<Record<FinderKeyword, { category: string; names: readonly string[] }>> = {
  restaurants: {
    category: 'Restaurant',
    names: [
      'Malwa Rasoi',
      'Annapurna Thali House',
      'Sarafa Bites',
      'Apna Dhaba',
      'Chappan Kitchen',
      'Poha Junction',
      'Narmada Family Restaurant',
      'Shree Bhojanalaya',
      'Upper Lake Cafe',
      'Bhopali Zaika',
      'Kebab Corner',
      'Green Chilli Restaurant',
      'Royal Dine',
      'Daal Baati House',
    ],
  },
  'dental clinic': {
    category: 'Dental clinic',
    names: [
      'Muskaan Dental Clinic',
      'Shubh Smile Dental',
      'Danta Care Centre',
      'Bright Smile Dental Studio',
      'Ujjwal Dental Clinic',
      'Healthy Teeth Clinic',
      'Sparkle Dental Centre',
      'Prakash Dental Hospital',
      'Pearl Dental Care',
      'Smile Craft Dental',
      'Tooth Fairy Dental Clinic',
      'Care Plus Dental',
      'Lake City Dental',
      'Arera Dental Studio',
    ],
  },
  salon: {
    category: 'Beauty salon',
    names: [
      'Glow Unisex Salon',
      'Kesh Kala Hair Studio',
      'Shringar Beauty Parlour',
      'Mirror Image Salon',
      'Nikhaar Makeover Studio',
      'Style Point Salon',
      'Rupam Beauty Lounge',
      'Tarasha Hair and Beauty',
      'Blush Family Salon',
      'Velvet Touch Salon',
      'Trim and Shine',
      'Roop Sajja Salon',
      'Lakeview Hair Lounge',
      'Studio Saaj',
    ],
  },
};

export type PresentationPlace = {
  /** `<keyword>|<location>|<index>`: the stable key of a place in this run. */
  key: string;
  keyword: FinderKeyword;
  location: FinderLocation;
  /** Position of the cell in the run (search order) and of the place in its cell (provider order). */
  cellIndex: number;
  index: number;
  placeId: string;
  name: string;
  category: string;
  /** Display form `+91 98xxx xxxxx`, or null when the listing has no phone. */
  phone: string | null;
  website: string | null;
  websiteListed: boolean;
  ratingX10: number;
  reviewCount: number;
  address: string;
  city: FinderLocation;
  state: string;
  pincode: string;
  imported: boolean;
};

export const placeKey = (keyword: FinderKeyword, location: FinderLocation, index: number): string => `${keyword}|${location}|${index}`;

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** The 40 simulated places of the run, in search order (deterministic). */
export function presentationPlaces(): PresentationPlace[] {
  const out: PresentationPlace[] = [];
  const offsets: Record<FinderKeyword, number> = { restaurants: 0, 'dental clinic': 0, salon: 0 };
  FINDER_RUN_FIXTURE.cells.forEach((cell: CellFixture, cellIndex) => {
    const kind = KINDS[cell.keyword];
    const localities = LOCALITIES[cell.location];
    for (let index = 0; index < cell.pattern.length; index += 1) {
      const key = placeKey(cell.keyword, cell.location, index);
      const seed = `${PRESENTATION_SLUG}:place:${key}`;
      const name = kind.names[offsets[cell.keyword] + index];
      if (name === undefined) throw new Error(`presentation fixture error: no name for ${key}`);
      const locality = localities[seedHash(`${seed}:locality`) % localities.length]!;
      const websiteListed = cell.pattern[index] === 'W';
      out.push({
        key,
        keyword: cell.keyword,
        location: cell.location,
        cellIndex,
        index,
        placeId: `ChIJdemo${seedHash(`${seed}:place`).toString(36)}`,
        name,
        category: kind.category,
        phone: cell.noPhone?.includes(index) ? null : demoMobile(`${seed}:phone`),
        website: websiteListed ? `https://${slug(name)}.demo-leads.in/` : null,
        websiteListed,
        ratingX10: 36 + (seedHash(`${seed}:rating`) % 14),
        reviewCount: 12 + (seedHash(`${seed}:reviews`) % 600),
        address: `${(seedHash(`${seed}:number`) % 250) + 1}, ${locality.name}, ${cell.location}, ${STATE} ${locality.pincode}`,
        city: cell.location,
        state: STATE,
        pincode: locality.pincode,
        imported: cell.imported.includes(index),
      });
    }
    offsets[cell.keyword] += cell.pattern.length;
  });
  return out;
}

// ---- Leads, opt-ins, chats and the handoff ------------------------------------------------------

/** The four leads the story walks through (place keys). */
export const STORY_LEADS = {
  /** Malwa Rasoi: opted in, automatic replies answer its service questions. */
  autoChat: placeKey('restaurants', 'Indore', 0),
  /** Glow Unisex Salon: opted in, asked for a price; the thread waits for a person. */
  escalated: placeKey('salon', 'Indore', 0),
  /** Muskaan Dental Clinic: opted in, not messaged yet (ready for a template send). */
  optInOnly: placeKey('dental clinic', 'Indore', 0),
  /** Pearl Dental Care: wrote in through the click-to-chat link and was handed over to the client. */
  handedOver: placeKey('dental clinic', 'Bhopal', 1),
} as const;

export type OptInMethod = 'CALL_VERBAL' | 'WRITTEN_FORM' | 'WEBSITE_FORM' | 'IN_PERSON' | 'WHATSAPP_THREAD';

/** Recorded WhatsApp MARKETING opt-ins (ADR-125): the evidence method, a note and when it was given. */
export const OPT_IN_FIXTURES: ReadonlyArray<{ place: string; method: OptInMethod; note: string; collectedMinutesAgo: number }> = [
  { place: STORY_LEADS.autoChat, method: 'CALL_VERBAL', note: 'Owner agreed on a phone call to receive WhatsApp messages about a website.', collectedMinutesAgo: 10 * 60 },
  { place: STORY_LEADS.escalated, method: 'CALL_VERBAL', note: 'Manager agreed on a phone call to receive WhatsApp messages about an online store.', collectedMinutesAgo: 9 * 60 + 40 },
  { place: STORY_LEADS.optInOnly, method: 'IN_PERSON', note: 'Clinic owner agreed in person during a visit to receive WhatsApp messages about a website.', collectedMinutesAgo: 8 * 60 },
];

export type MessageFixture = {
  key: string;
  direction: 'IN' | 'OUT';
  minutesAgo: number;
  /** TEXT body; a TEMPLATE message names its template and carries positional variables instead. */
  body?: string;
  template?: string;
  status: 'DELIVERED' | 'READ';
  /** Outbound only: who wrote it (`human` is the operator). */
  generatorLabel?: 'human' | 'local-deterministic' | 'reply-guard';
  sendIntent?: 'MANUAL_SINGLE' | 'AUTOMATED';
  /** Outbound automated replies answer this inbound message (fixture key). */
  replyTo?: string;
};

export type ConversationFixture = {
  key: string;
  place: string;
  aiMode: 'OFF' | 'DRAFT' | 'AUTO';
  humanTakeover: boolean;
  modeVersion: number;
  /** The message whose automated acknowledgement escalated the thread (feeds "Needs you", ADR-122). */
  escalatedBy?: string;
  messages: readonly MessageFixture[];
};

/** ADR-122: the first automated reply in each window starts with this disclosure. */
export const AUTOMATED_DISCLOSURE = `${PRESENTATION_BUSINESS}'s automated assistant. Reply HUMAN to talk to a person.`;
/** reply-guard's fixed acknowledgement of a price request (src/server/services/ai/reply-guard.ts). */
const QUOTE_REQUEST_ACK = 'Thank you. A member of our team will prepare your quotation and share it here.';

export const REPLY_INITIATOR = 'system:reply.auto';

export const CONVERSATION_FIXTURES: readonly ConversationFixture[] = [
  {
    key: 'auto-chat',
    place: STORY_LEADS.autoChat,
    aiMode: 'AUTO',
    humanTakeover: false,
    modeVersion: 1,
    messages: [
      { key: 'intro', direction: 'OUT', minutesAgo: 9 * 60, template: 'website_intro', status: 'READ', generatorLabel: 'human', sendIntent: 'MANUAL_SINGLE' },
      { key: 'ask-website', direction: 'IN', minutesAgo: 50, body: 'Hi, what do you include in a business website? We need one for our restaurant.', status: 'DELIVERED' },
      {
        key: 'answer-website',
        direction: 'OUT',
        minutesAgo: 49,
        body: `${AUTOMATED_DISCLOSURE}\n\nOur Business website is a responsive five-page website with a contact form, a WhatsApp chat button and your Google Maps location. It usually takes 14 days.`,
        status: 'READ',
        generatorLabel: 'local-deterministic',
        sendIntent: 'AUTOMATED',
        replyTo: 'ask-website',
      },
      { key: 'ask-seo', direction: 'IN', minutesAgo: 35, body: 'Can you also set up our Google listing so people find us?', status: 'DELIVERED' },
      {
        key: 'answer-seo',
        direction: 'OUT',
        minutesAgo: 34,
        body: 'Yes. Our SEO setup covers your Google Business Profile, on-page SEO, a sitemap and Search Console. It usually takes 10 days.',
        status: 'DELIVERED',
        generatorLabel: 'local-deterministic',
        sendIntent: 'AUTOMATED',
        replyTo: 'ask-seo',
      },
    ],
  },
  {
    key: 'escalated',
    place: STORY_LEADS.escalated,
    aiMode: 'AUTO',
    humanTakeover: false,
    modeVersion: 1,
    escalatedBy: 'ack-price',
    messages: [
      { key: 'intro', direction: 'OUT', minutesAgo: 9 * 60 + 20, template: 'website_intro', status: 'READ', generatorLabel: 'human', sendIntent: 'MANUAL_SINGLE' },
      { key: 'ask-price', direction: 'IN', minutesAgo: 20, body: 'How much will an online store cost? We want to sell our hair care products.', status: 'DELIVERED' },
      {
        key: 'ack-price',
        direction: 'OUT',
        minutesAgo: 19,
        body: `${AUTOMATED_DISCLOSURE}\n\n${QUOTE_REQUEST_ACK}`,
        status: 'DELIVERED',
        generatorLabel: 'reply-guard',
        sendIntent: 'AUTOMATED',
        replyTo: 'ask-price',
      },
    ],
  },
  {
    key: 'handed-over',
    place: STORY_LEADS.handedOver,
    aiMode: 'OFF',
    humanTakeover: true,
    modeVersion: 1,
    messages: [
      {
        key: 'hello',
        direction: 'IN',
        minutesAgo: 8 * 60,
        body: 'Hello, I found your WhatsApp link on the Codecraft website. We are a dental clinic in Bhopal and need a website where patients can book appointments.',
        status: 'DELIVERED',
      },
      {
        key: 'reply-call',
        direction: 'OUT',
        minutesAgo: 7 * 60 + 50,
        body: 'Thank you for writing to Codecraft Web Studio. A business website with an appointment form usually takes about 14 days. Can we call you to understand what your clinic needs?',
        status: 'READ',
        generatorLabel: 'human',
        sendIntent: 'MANUAL_SINGLE',
      },
      { key: 'call-time', direction: 'IN', minutesAgo: 5 * 60, body: 'Yes, please call after 4 pm. We also want patients to find us on Google.', status: 'DELIVERED' },
      {
        key: 'reply-quote',
        direction: 'OUT',
        minutesAgo: 4 * 60,
        body: 'Noted, thank you. Our project lead will share a quotation for the website and the SEO setup with you here.',
        status: 'READ',
        generatorLabel: 'human',
        sendIntent: 'MANUAL_SINGLE',
      },
    ],
  },
];

/** The lead handed over to the client (ADR-124): note, local summary, 3 hours before the anchor. */
export const HANDOFF_FIXTURE = {
  place: STORY_LEADS.handedOver,
  minutesAgo: 3 * 60,
  note: 'Wants a website with online appointment booking and to be found on Google. Prefers a call after 4 pm.',
  summary:
    'Pearl Dental Care, a dental clinic in Bhopal, wrote in on WhatsApp through the website link. They want a business website where patients can book appointments, and help being found on Google (SEO setup). They asked for a call after 4 pm. No price has been discussed yet.',
  summaryGeneratorLabel: 'local-deterministic',
} as const;

// ---- WhatsApp templates (ADR-123) ---------------------------------------------------------------

export type TemplateFixture = {
  name: string;
  category: 'MARKETING' | 'UTILITY';
  /** Raw provider status strings (never enums). */
  status: 'APPROVED' | 'PENDING' | 'REJECTED';
  intent: 'FIRST_TOUCH' | 'FOLLOW_UP' | null;
  components: ReadonlyArray<Record<string, unknown>>;
  /** Body variable sources by position. */
  variables: Readonly<Record<string, TemplateVariableSource>>;
  /** Quick-reply intents by button index. */
  buttons: Readonly<Record<string, 'QUOTE' | 'CALL' | 'STOP'>>;
  submittedMinutesAgo: number;
  /** The simulated review decided this many seconds after the submission (null while pending). */
  reviewedAfterSeconds: number | null;
  rejectedReason: string | null;
  utilityTrigger: string | null;
  copyGeneratorLabel: string | null;
};

const STOP_FOOTER = { type: 'FOOTER', text: 'Reply STOP to stop these messages' };
const CALL_AND_STOP = { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Request a call' }, { type: 'QUICK_REPLY', text: 'Stop' }] };
const DAY_MINUTES = 24 * 60;

export const TEMPLATE_FIXTURES: readonly TemplateFixture[] = [
  {
    name: 'website_intro',
    category: 'MARKETING',
    status: 'APPROVED',
    intent: 'FIRST_TOUCH',
    components: [
      {
        type: 'BODY',
        text: 'Hello {{1}}, this is {{2}} from Indore. We build fast, mobile-friendly websites for local businesses, with your services, timings, a WhatsApp button and your Google Maps location. Would you like a free sample homepage?',
      },
      STOP_FOOTER,
      CALL_AND_STOP,
    ],
    variables: { '1': 'lead.displayName', '2': 'workspace.name' },
    buttons: { '0': 'CALL', '1': 'STOP' },
    submittedMinutesAgo: 20 * DAY_MINUTES,
    reviewedAfterSeconds: 30,
    rejectedReason: null,
    utilityTrigger: null,
    copyGeneratorLabel: null,
  },
  {
    name: 'follow_up',
    category: 'MARKETING',
    status: 'APPROVED',
    intent: 'FOLLOW_UP',
    components: [
      {
        type: 'BODY',
        text: 'Hello {{1}}, a quick follow-up from {{2}}. Most customers look a business up on Google before they visit. A simple website with your timings, photos and a WhatsApp button helps them choose you. Shall we send you a sample?',
      },
      STOP_FOOTER,
      CALL_AND_STOP,
    ],
    variables: { '1': 'lead.displayName', '2': 'workspace.name' },
    buttons: { '0': 'CALL', '1': 'STOP' },
    submittedMinutesAgo: 20 * DAY_MINUTES,
    reviewedAfterSeconds: 30,
    rejectedReason: null,
    utilityTrigger: null,
    copyGeneratorLabel: null,
  },
  {
    name: 'meeting_confirm',
    category: 'UTILITY',
    status: 'APPROVED',
    intent: null,
    components: [{ type: 'BODY', text: 'Hello {{1}}, your website consultation with {{2}} is confirmed for {{3}}. Reply here if you need to change the time.' }],
    variables: { '1': 'lead.displayName', '2': 'workspace.name', '3': 'manual' },
    buttons: {},
    submittedMinutesAgo: 18 * DAY_MINUTES,
    reviewedAfterSeconds: 30,
    rejectedReason: null,
    utilityTrigger: 'MEETING_BOOKED',
    copyGeneratorLabel: null,
  },
  {
    name: 'brochure_share',
    category: 'MARKETING',
    status: 'PENDING',
    intent: null,
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Website packages' },
      {
        type: 'BODY',
        text: 'Hello {{1}}, here are the website packages from {{2}}: business website, online store, landing page, SEO setup and monthly maintenance. Reply YES and we will send the brochure here.',
      },
      STOP_FOOTER,
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Stop' }] },
    ],
    variables: { '1': 'lead.displayName', '2': 'workspace.name' },
    buttons: { '0': 'STOP' },
    submittedMinutesAgo: 2 * 60,
    reviewedAfterSeconds: null,
    rejectedReason: null,
    utilityTrigger: null,
    copyGeneratorLabel: 'local-deterministic',
  },
  {
    name: 'discount_blast',
    category: 'MARKETING',
    status: 'REJECTED',
    intent: null,
    components: [{ type: 'BODY', text: 'Flat 40% off on all websites this week only! Book today before the offer ends.' }],
    variables: {},
    buttons: {},
    submittedMinutesAgo: 15 * DAY_MINUTES,
    reviewedAfterSeconds: 30,
    rejectedReason: 'Simulated review: a time-limited discount that does not say who is sending it and gives no way to opt out.',
    utilityTrigger: null,
    copyGeneratorLabel: null,
  },
];
