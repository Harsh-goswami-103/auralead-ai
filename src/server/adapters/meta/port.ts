/**
 * Shapes the Meta adapters hand to the campaign services (T35): what a metrics sync fetched, and
 * what a status read-back returned. The live Graph/Marketing API adapter (graph.ts) parses the
 * provider's JSON into these; the DEMO adapter (demo.ts) builds simulated ones. Every status and
 * attribution string is the provider's raw value (plan §5.1: never enums); money stays a decimal
 * string in the ad account's own currency until the service turns it into minor units (P6: never
 * converted to another currency).
 */

export type FetchedAdAccount = {
  /** Digits only (without `act_`). */
  accountId: string;
  name: string | null;
  /** ISO 4217 code exactly as the ad account reports it. */
  currency: string;
  timezone: string | null;
};

export type FetchedCampaign = {
  providerCampaignId: string;
  name: string;
  /** `configured_status` when the provider returns it, else `status` (raw). */
  configuredStatus: string;
  /** `effective_status` (raw). */
  effectiveStatus: string;
};

export type FetchedInsight = {
  providerCampaignId: string;
  /** Calendar dates in the ad account's time zone, `YYYY-MM-DD`, as returned. */
  dateStart: string;
  dateStop: string;
  /** Major units in the ad account currency, as returned (for example "1842.50"). */
  spend: string;
  /** Lead actions in the window; Meta omits zero-valued actions, so absent means 0. */
  leads: number;
  /** Cost per lead as Meta reported it (major units), or null when it reported none. */
  costPerLead: string | null;
  /** `attribution_setting` as returned, or null when the answer has none. */
  attributionSetting: string | null;
};

export type CampaignMetricsFetch = {
  account: FetchedAdAccount;
  campaigns: FetchedCampaign[];
  insights: FetchedInsight[];
  /** The date preset the insights were asked for (for example `last_7d`). */
  datePreset: string;
  /** False when a page cap stopped the read before the provider's last page. */
  complete: boolean;
};

export type CampaignStatusRead = { providerCampaignId: string; configuredStatus: string; effectiveStatus: string };
