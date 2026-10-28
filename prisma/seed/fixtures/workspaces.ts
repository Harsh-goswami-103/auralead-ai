/**
 * Demo tenants (PRD "Seed and acceptance tests"): fictitious Indian service businesses in Delhi
 * NCR, Mumbai and Bengaluru: a dental clinic, a gym, a property agency, an e-commerce brand and a
 * freelance design studio. Every name, address and contact is invented; contacts use the
 * reserved `.test` / `example.com` domains so nothing is deliverable.
 *
 * The sixth tenant, `codecraft-web` (Codecraft Web Studio, Indore), is the presentation workspace
 * of the lead-gen suite (ADR-126): a web-development studio with its own scoring version, a
 * WhatsApp opt-in notice and automatic sending on. Its finder run, leads, chats and templates are
 * in fixtures/presentation.ts. The other five tenants are unchanged by it.
 *
 * Prices are whole rupees stored as BigInt paise (ADR-07). Tax: GST 18% where the business is
 * GST-registered, explicit NONE for the freelancer below the threshold (plan §8, explicit mode).
 */
import { CODECRAFT_SCORING_V1, PRESENTATION_BUSINESS, PRESENTATION_OPT_IN_NOTICE, PRESENTATION_PRIVACY_CONTACT, PRESENTATION_SLUG } from './presentation';

export const REQUIRED_CITIES = ['Delhi NCR', 'Mumbai', 'Bengaluru'] as const;
/** The required cities plus the presentation workspace's city (ADR-126). */
export type City = (typeof REQUIRED_CITIES)[number] | 'Indore';

export const REQUIRED_CATEGORIES = ['clinic', 'gym', 'property', 'ecommerce', 'freelancer'] as const;
/** The required categories plus the presentation web studio (ADR-126). */
export type BusinessCategory = (typeof REQUIRED_CATEGORIES)[number] | 'web-studio';

export type ServiceFixture = {
  code: string;
  name: string;
  description: string;
  unitLabel: string;
  defaultTimelineDays: number | null;
  maxDiscountBps: number | null;
  /** Rupees; stored as paise. */
  unitPriceRupees: number;
  minQty?: number;
  maxQty?: number;
};

export type WorkspaceFixture = {
  slug: string;
  name: string;
  city: City;
  locality: string;
  category: BusinessCategory;
  planLabel: string;
  /** Days before SEED_NOW the workspace was created (re-based by demo:refresh). */
  createdDaysAgo: number;
  settings: {
    taxMode: 'NONE' | 'CONFIGURED';
    taxLabel: string | null;
    taxBps: number | null;
    maxDiscountBps: number;
    quoteValidityDays: number;
    brandColor: string;
    bookingUrl: string | null;
    autoSendEnabled: boolean;
    emailB2bAttestationEnabled: boolean;
    emailFallbackEnabled: boolean;
    internalWaDailyCap: number | null;
    internalEmailDailyCap: number | null;
    /** ADR-125: the WhatsApp opt-in notice prefilled when an opt-in is recorded (null when absent). */
    whatsappOptInNotice?: string;
    /** ADR-125: who to contact about personal data (null when absent). */
    privacyContact?: string;
  };
  services: ServiceFixture[];
  /** Scoring config version 1; fixtures/configs.ts SCORING_V1 when not given. */
  scoring?: Readonly<Record<string, unknown>>;
};

const GST = { taxMode: 'CONFIGURED', taxLabel: 'GST', taxBps: 1800 } as const;

/** The presentation web studio (ADR-126): GST-registered, automatic sending on (ADR-121). */
const CODECRAFT_WEB: WorkspaceFixture = {
  slug: PRESENTATION_SLUG,
  name: PRESENTATION_BUSINESS,
  city: 'Indore',
  locality: 'Vijay Nagar, Indore',
  category: 'web-studio',
  planLabel: 'Growth',
  createdDaysAgo: 30,
  settings: {
    ...GST,
    maxDiscountBps: 1500,
    quoteValidityDays: 15,
    brandColor: '#1D4ED8',
    bookingUrl: 'https://example.com/call/codecraft',
    autoSendEnabled: true,
    emailB2bAttestationEnabled: true,
    emailFallbackEnabled: false,
    internalWaDailyCap: 250,
    internalEmailDailyCap: 100,
    whatsappOptInNotice: PRESENTATION_OPT_IN_NOTICE,
    privacyContact: PRESENTATION_PRIVACY_CONTACT,
  },
  services: [
    {
      code: 'WEB-BIZ',
      name: 'Business website',
      description: 'A responsive five-page website with a contact form, a WhatsApp chat button and your Google Maps location.',
      unitLabel: 'website',
      defaultTimelineDays: 14,
      maxDiscountBps: 1000,
      unitPriceRupees: 24000,
      maxQty: 5,
    },
    {
      code: 'WEB-SHOP',
      name: 'E-commerce store',
      description: 'An online store for up to 100 products with UPI and card payments and order emails.',
      unitLabel: 'store',
      defaultTimelineDays: 30,
      maxDiscountBps: 1000,
      unitPriceRupees: 60000,
      maxQty: 2,
    },
    {
      code: 'WEB-LAND',
      name: 'Landing page',
      description: 'One landing page for an offer or a campaign, with a lead form.',
      unitLabel: 'page',
      defaultTimelineDays: 5,
      maxDiscountBps: 1500,
      unitPriceRupees: 8000,
      maxQty: 10,
    },
    {
      code: 'SEO-SETUP',
      name: 'SEO setup',
      description: 'Google Business Profile, on-page SEO, a sitemap and Search Console setup.',
      unitLabel: 'setup',
      defaultTimelineDays: 10,
      maxDiscountBps: 1000,
      unitPriceRupees: 12000,
      maxQty: 1,
    },
    {
      code: 'WEB-CARE',
      name: 'Website maintenance',
      description: 'Monthly content updates, backups, security updates and uptime checks.',
      unitLabel: 'month',
      defaultTimelineDays: 30,
      maxDiscountBps: 500,
      unitPriceRupees: 2500,
      maxQty: 24,
    },
  ],
  scoring: CODECRAFT_SCORING_V1,
};

export const WORKSPACE_FIXTURES: readonly WorkspaceFixture[] = [
  {
    slug: 'smile-avenue-dental',
    name: 'Smile Avenue Dental Clinic',
    city: 'Delhi NCR',
    locality: 'Sector 56, Gurugram',
    category: 'clinic',
    planLabel: 'Growth',
    createdDaysAgo: 120,
    settings: {
      ...GST,
      maxDiscountBps: 1500,
      quoteValidityDays: 15,
      brandColor: '#0E7490',
      bookingUrl: 'https://example.com/book/smile-avenue',
      autoSendEnabled: false,
      emailB2bAttestationEnabled: false,
      emailFallbackEnabled: true,
      internalWaDailyCap: 250,
      internalEmailDailyCap: 100,
    },
    services: [
      { code: 'CONSULT', name: 'Dental consultation and X-ray', description: 'Examination by a dentist with one digital OPG X-ray.', unitLabel: 'visit', defaultTimelineDays: 1, maxDiscountBps: 0, unitPriceRupees: 800 },
      { code: 'WHITEN', name: 'Teeth whitening (in-clinic)', description: 'One 60-minute in-clinic whitening session.', unitLabel: 'session', defaultTimelineDays: 1, maxDiscountBps: 1000, unitPriceRupees: 8500 },
      { code: 'RCT', name: 'Root canal treatment', description: 'Single-tooth root canal treatment, crown quoted separately.', unitLabel: 'tooth', defaultTimelineDays: 7, maxDiscountBps: 500, unitPriceRupees: 6500, maxQty: 8 },
      { code: 'ALIGN', name: 'Clear aligner plan', description: 'Full clear aligner course with scans and reviews.', unitLabel: 'plan', defaultTimelineDays: 180, maxDiscountBps: 1500, unitPriceRupees: 145000, maxQty: 1 },
    ],
  },
  {
    slug: 'ironpulse-fitness',
    name: 'IronPulse Fitness Studio',
    city: 'Mumbai',
    locality: 'Andheri West, Mumbai',
    category: 'gym',
    planLabel: 'Starter',
    createdDaysAgo: 90,
    settings: {
      ...GST,
      maxDiscountBps: 2000,
      quoteValidityDays: 7,
      brandColor: '#B45309',
      bookingUrl: null,
      autoSendEnabled: false,
      emailB2bAttestationEnabled: false,
      emailFallbackEnabled: false,
      internalWaDailyCap: 150,
      internalEmailDailyCap: null,
    },
    services: [
      { code: 'MEM-3M', name: 'Quarterly membership', description: 'Three months of unlimited floor access and group classes.', unitLabel: 'membership', defaultTimelineDays: 90, maxDiscountBps: 2000, unitPriceRupees: 9000 },
      { code: 'PT-12', name: 'Personal training pack', description: 'Twelve one-to-one sessions with a certified coach.', unitLabel: 'pack', defaultTimelineDays: 42, maxDiscountBps: 1000, unitPriceRupees: 14400 },
      { code: 'CORP-WELL', name: 'Corporate wellness workshop', description: 'A 90-minute on-site workshop for up to 40 employees.', unitLabel: 'workshop', defaultTimelineDays: 14, maxDiscountBps: 1500, unitPriceRupees: 25000, maxQty: 12 },
    ],
  },
  {
    slug: 'nestkey-realty',
    name: 'NestKey Realty Advisors',
    city: 'Bengaluru',
    locality: 'Whitefield, Bengaluru',
    category: 'property',
    planLabel: 'Growth',
    createdDaysAgo: 75,
    settings: {
      ...GST,
      maxDiscountBps: 1000,
      quoteValidityDays: 30,
      brandColor: '#4D7C0F',
      bookingUrl: 'https://example.com/visits/nestkey',
      autoSendEnabled: false,
      emailB2bAttestationEnabled: true,
      emailFallbackEnabled: true,
      internalWaDailyCap: 200,
      internalEmailDailyCap: 200,
    },
    services: [
      { code: 'RENT-LIST', name: 'Rental listing and tenant screening', description: 'Listing on partner portals, verified tenant shortlist, agreement draft.', unitLabel: 'property', defaultTimelineDays: 21, maxDiscountBps: 1000, unitPriceRupees: 18000 },
      { code: 'SITE-VISIT', name: 'Guided site visit', description: 'Accompanied visit to up to three shortlisted properties.', unitLabel: 'visit', defaultTimelineDays: 3, maxDiscountBps: 0, unitPriceRupees: 1500 },
      { code: 'DOCS', name: 'Sale documentation assistance', description: 'Title check coordination, agreement review and registration support.', unitLabel: 'transaction', defaultTimelineDays: 30, maxDiscountBps: 500, unitPriceRupees: 35000, maxQty: 1 },
    ],
  },
  {
    slug: 'kesari-crafts',
    name: 'Kesari Crafts Online',
    city: 'Delhi NCR',
    locality: 'Sector 63, Noida',
    category: 'ecommerce',
    planLabel: 'Starter',
    createdDaysAgo: 60,
    settings: {
      ...GST,
      maxDiscountBps: 2500,
      quoteValidityDays: 10,
      brandColor: '#C2410C',
      bookingUrl: null,
      autoSendEnabled: false,
      emailB2bAttestationEnabled: true,
      emailFallbackEnabled: true,
      internalWaDailyCap: 300,
      internalEmailDailyCap: 300,
    },
    services: [
      { code: 'HAMPER-CORP', name: 'Corporate Diwali hamper', description: 'Brass diya pair, dry fruits and a handmade card, gift boxed.', unitLabel: 'hamper', defaultTimelineDays: 10, maxDiscountBps: 2500, unitPriceRupees: 1850, minQty: 10, maxQty: 2000 },
      { code: 'DIYA-SET', name: 'Hand-cast brass diya set', description: 'Set of four hand-cast brass diyas.', unitLabel: 'set', defaultTimelineDays: 7, maxDiscountBps: 1500, unitPriceRupees: 1200 },
      { code: 'BRANDING', name: 'Custom logo engraving', description: 'Laser engraving of the client logo on each item.', unitLabel: 'item', defaultTimelineDays: 5, maxDiscountBps: 1000, unitPriceRupees: 150, maxQty: 5000 },
    ],
  },
  {
    slug: 'pixelchai-studio',
    name: 'PixelChai Design Studio',
    city: 'Bengaluru',
    locality: 'Koramangala, Bengaluru',
    category: 'freelancer',
    planLabel: 'Solo',
    createdDaysAgo: 45,
    settings: {
      taxMode: 'NONE',
      taxLabel: null,
      taxBps: null,
      maxDiscountBps: 1000,
      quoteValidityDays: 14,
      brandColor: '#7C3AED',
      bookingUrl: 'https://example.com/call/pixelchai',
      autoSendEnabled: false,
      emailB2bAttestationEnabled: false,
      emailFallbackEnabled: false,
      internalWaDailyCap: 50,
      internalEmailDailyCap: 50,
    },
    services: [
      { code: 'BRAND-KIT', name: 'Logo and brand kit', description: 'Logo, colour palette, type pairing and a one-page brand guide.', unitLabel: 'project', defaultTimelineDays: 14, maxDiscountBps: 1000, unitPriceRupees: 30000, maxQty: 1 },
      { code: 'LANDING', name: 'Landing page design', description: 'One responsive landing page in Figma, two revision rounds.', unitLabel: 'page', defaultTimelineDays: 10, maxDiscountBps: 1000, unitPriceRupees: 22000, maxQty: 5 },
      { code: 'SOCIAL-M', name: 'Social media creatives', description: 'Twelve post designs per month for Instagram and LinkedIn.', unitLabel: 'month', defaultTimelineDays: 30, maxDiscountBps: 500, unitPriceRupees: 12000, maxQty: 12 },
    ],
  },
  CODECRAFT_WEB,
];

/** Quotation terms shown on quotes; the jurisdiction line names the business's city. */
export function termsFor(ws: WorkspaceFixture): string {
  const lines = [
    `Prices are in Indian Rupees (INR) and valid for ${ws.settings.quoteValidityDays} days from the quote date.`,
    ws.settings.taxMode === 'CONFIGURED' ? 'GST is charged as shown on the quote.' : 'No GST is charged: the supplier is not GST-registered.',
    '50% advance confirms the booking; the balance is due on completion.',
    `${ws.name}, ${ws.locality}. Subject to ${ws.city} jurisdiction.`,
  ];
  return lines.join('\n');
}
