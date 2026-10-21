/**
 * P6 and the Meta adapter's pure parts (T35): decimal amounts become integer minor units of the
 * SAME currency (INR 2 digits, JPY 0, KWD 3; explicit half-up rounding; unknown currency or junk is
 * null, never guessed); insights rows keep their window and attribution as returned; leads count
 * the lead action only; a consent checkbox from custom disclaimer answers becomes an answer key;
 * failures name the permission.
 */
import { describe, expect, it } from 'vitest';
import { currencyMinorDigits, decimalToMinor } from '@/lib/ad-currency';
import { classifyMetaFailure, parseCampaign, parseGraphLead, parseInsight } from '@/server/adapters/meta/graph';

describe('decimalToMinor', () => {
  it('keeps the currency and its minor digits', () => {
    expect(currencyMinorDigits('INR')).toBe(2);
    expect(currencyMinorDigits('JPY')).toBe(0);
    expect(currencyMinorDigits('KWD')).toBe(3);
    expect(decimalToMinor('1842.50', 'INR')).toBe(184250n);
    expect(decimalToMinor('1842.5', 'USD')).toBe(184250n);
    expect(decimalToMinor('1234', 'JPY')).toBe(1234n);
    expect(decimalToMinor('1.2345', 'KWD')).toBe(1235n);
    expect(decimalToMinor('13.716667', 'USD')).toBe(1372n);
    expect(decimalToMinor('0.004', 'USD')).toBe(0n);
    expect(decimalToMinor('0.005', 'USD')).toBe(1n);
  });

  it('refuses what it cannot read', () => {
    expect(decimalToMinor('-1.00', 'INR')).toBeNull();
    expect(decimalToMinor('1e3', 'INR')).toBeNull();
    expect(decimalToMinor('12.00', 'inr')).toBeNull();
    expect(decimalToMinor('12.00', 'ZZZ1')).toBeNull();
  });
});

describe('Graph parsers', () => {
  it('insights: spend as returned, the lead action only, window and attribution as returned', () => {
    const row = parseInsight({ campaign_id: '410000000000001', spend: '99.10', date_start: '2026-10-13', date_stop: '2026-10-19', attribution_setting: 'mixed', actions: [{ action_type: 'link_click', value: '50' }, { action_type: 'onsite_conversion.lead_grouped', value: '4' }] });
    expect(row).toEqual({ providerCampaignId: '410000000000001', dateStart: '2026-10-13', dateStop: '2026-10-19', spend: '99.10', leads: 4, costPerLead: null, attributionSetting: 'mixed' });
    expect(parseInsight({ campaign_id: '410000000000001', spend: '1.00', date_start: '2026-10-13', date_stop: '2026-10-19' })).toMatchObject({ leads: 0, attributionSetting: null });
    expect(parseInsight({ campaign_id: 'abc', spend: '1', date_start: '2026-10-13', date_stop: '2026-10-19' })).toBeNull();
  });

  it('campaigns keep raw statuses; leads fold disclaimer checkboxes into answers', () => {
    expect(parseCampaign({ id: '410000000000001', name: 'X', status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED' })).toEqual({ providerCampaignId: '410000000000001', name: 'X', configuredStatus: 'ACTIVE', effectiveStatus: 'CAMPAIGN_PAUSED' });
    const lead = parseGraphLead({ id: '610000000000001', created_time: '2026-10-20T05:59:50+0000', field_data: [{ name: 'full_name', values: ['राहुल'] }], custom_disclaimer_responses: [{ checkbox_key: 'optin', is_checked: '1' }] });
    expect(lead?.field_data).toEqual([
      { name: 'full_name', values: ['राहुल'] },
      { name: 'optin', values: ['1'] },
    ]);
  });

  it('failures: 190 is auth; a permission refusal names Meta’s permission or the operation’s own', () => {
    const response = (code: number, message: string, status = 400) => ({ ok: false as const, phase: 'response' as const, status, error: { code: String(code), subcode: null, type: null, message } });
    expect(classifyMetaFailure(response(190, 'expired'), 'leads_retrieval').code).toBe('PROVIDER_AUTH');
    expect(classifyMetaFailure(response(200, '(#200) Requires pages_read_engagement permission'), 'leads_retrieval')).toMatchObject({ code: 'PERMISSION_MISSING', permission: 'pages_read_engagement' });
    expect(classifyMetaFailure(response(10, 'no permission', 403), 'ads_management')).toMatchObject({ code: 'PERMISSION_MISSING', permission: 'ads_management' });
    expect(classifyMetaFailure(response(80004, 'too many calls'), 'ads_read').code).toBe('PROVIDER_RATE_LIMITED');
    expect(classifyMetaFailure({ ok: false, phase: 'after-write', status: null, error: { code: null, subcode: null, type: null, message: 'UND_ERR_HEADERS_TIMEOUT' } }, 'ads_management')).toMatchObject({ code: 'PROVIDER_UNREACHABLE', phase: 'after-write' });
  });
});
