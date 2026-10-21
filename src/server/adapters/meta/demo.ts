/**
 * Meta Lead Ads DEMO adapter (T11, R11). It stands in for both halves of the live flow: the Page
 * webhook's `leadgen` change (ids only) and the Graph API lead retrieval (`GET /{leadgen_id}` with
 * `field_data`), returning the same shapes (`metaLeadEventSchema`) so the simulated event is
 * processed by the same `ingest.process` path as a live one. No network, no randomness: a lead is
 * a pure function of its leadgen id.
 *
 * Every simulated workspace shares one fictitious Page and form id, so identical leadgen ids sent
 * to two workspaces produce identical `meta:{page}:{leadgen}` keys and the scope key (the
 * workspace's own integration, E2) is what keeps them apart. Field names follow Meta's standard
 * questions (`full_name`, `phone_number`, `email`, `city`) plus one custom consent question.
 */
import { demoPerson } from '@/lib/demo/contacts';
import type { ConsentMapping } from '@/lib/schemas/ingest';
import type { FieldMap, MetaLeadEvent } from '@/lib/schemas/webhooks';
import type { CampaignMetricsFetch } from './port';

export const DEMO_META_PAGE_ID = '100000000000001';
export const DEMO_META_FORM_ID = '200000000000001';
const DEMO_META_AD_ID = '300000000000001';
const DEMO_META_CAMPAIGN_ID = '400000000000001';

export const DEMO_META_FIELD_MAP = {
  name: 'full_name',
  phone: 'phone_number',
  email: 'email',
  city: 'city',
} as const satisfies FieldMap;

export const DEMO_META_CONSENT: ConsentMapping = {
  column: 'whatsapp_updates',
  truthyValues: ['yes'],
  channel: 'WHATSAPP',
  purpose: 'MARKETING',
  noticeText: 'I agree to receive updates about my enquiry and offers on WhatsApp. I can opt out at any time by replying STOP.',
  noticeVersion: 'demo-instant-form-v1',
};

/** `2026-10-16T05:59:00+0000`, the Graph API timestamp format. */
function graphTime(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, '+0000');
}

export type SimulatedLeadgenInput = {
  /** Each lead's leadgen id is `<batchId>-<index>`. */
  batchId: string;
  count: number;
  fieldMap: FieldMap;
  consentQuestion: string | null;
  formId: string;
  pageId: string;
  /** Creation time of the newest lead; earlier leads are one minute apart. */
  createdAt: Date;
};

export function buildSimulatedLeadgenEvents(input: SimulatedLeadgenInput): MetaLeadEvent[] {
  return Array.from({ length: input.count }, (_, i) => {
    const leadgenId = `${input.batchId}-${i}`;
    const person = demoPerson(`meta:${leadgenId}`);
    const createdAt = new Date(Math.floor((input.createdAt.getTime() - (input.count - 1 - i) * 60_000) / 1000) * 1000);
    const answers: Record<string, string> = { name: person.name, phone: person.phone, email: person.email, city: person.city };
    const fieldData = Object.entries(input.fieldMap).flatMap(([field, question]) => {
      const value = answers[field];
      return question && value !== undefined ? [{ name: question, values: [value] }] : [];
    });
    if (input.consentQuestion) fieldData.push({ name: input.consentQuestion, values: [i % 2 === 0 ? 'yes' : 'no'] });
    return {
      change: {
        leadgen_id: leadgenId,
        page_id: input.pageId,
        form_id: input.formId,
        ad_id: DEMO_META_AD_ID,
        adgroup_id: DEMO_META_AD_ID,
        created_time: Math.floor(createdAt.getTime() / 1000),
      },
      lead: {
        id: leadgenId,
        created_time: graphTime(createdAt),
        form_id: input.formId,
        ad_id: DEMO_META_AD_ID,
        campaign_id: DEMO_META_CAMPAIGN_ID,
        field_data: fieldData,
      },
    };
  });
}

// ---- Campaign metrics (T35) ---------------------------------------------------------------------

export const DEMO_META_AD_ACCOUNT_ID = '500000000000001';
/** The campaign every simulated Instant Form lead is attributed to. */
export const DEMO_META_LEAD_CAMPAIGN_ID = DEMO_META_CAMPAIGN_ID;

/**
 * DEMO stands in for the Marketing API (T35, ADR-108): a fixed ad account in INR with two
 * campaigns and their last-7-days insights, built from the clock only. Everything it returns is
 * stored with `simulated = true` and shown labelled Simulated; Meta is never contacted.
 */
export function buildDemoCampaignMetrics(now: Date): CampaignMetricsFetch {
  const day = 24 * 60 * 60 * 1000;
  const stop = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - day);
  const start = new Date(stop.getTime() - 6 * day);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    account: { accountId: DEMO_META_AD_ACCOUNT_ID, name: 'Demo ad account', currency: 'INR', timezone: 'Asia/Kolkata' },
    campaigns: [
      { providerCampaignId: DEMO_META_CAMPAIGN_ID, name: 'Instant Form: free check-up offer', configuredStatus: 'ACTIVE', effectiveStatus: 'ACTIVE' },
      { providerCampaignId: '400000000000002', name: 'Retargeting: website visitors', configuredStatus: 'PAUSED', effectiveStatus: 'PAUSED' },
    ],
    insights: [
      { providerCampaignId: DEMO_META_CAMPAIGN_ID, dateStart: iso(start), dateStop: iso(stop), spend: '1842.50', leads: 12, costPerLead: '153.54', attributionSetting: '7-day click or 1-day view' },
    ],
    datePreset: 'last_7d',
    complete: true,
  };
}
