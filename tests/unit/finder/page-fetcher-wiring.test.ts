// Adversarial review: the production page fetcher (`finderPageFetcher`) is what ADR-118 promises the
// websites: an identifying User-Agent built from the app origin, 8 seconds and 1 MB per page. The
// integration test builds its own fetcher, so this pins the real wiring (the options safeFetch gets).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { safeFetch } from '@/server/security/safe-fetch';
import { finderPageFetcher } from '@/server/jobs/handlers/lead-finder-emails';
import { EMAIL_PAGE_LIMITS } from '@/server/services/lead-finder/emails';

vi.mock('@/server/security/safe-fetch', () => ({ safeFetch: vi.fn(async () => ({ body: '' })) }));

beforeEach(() => vi.mocked(safeFetch).mockClear());

describe('finderPageFetcher', () => {
  it('identifies the bot from the app origin and applies the ADR-118 limits', async () => {
    await finderPageFetcher('https://app.example/')('https://shop.example/');
    const [url, options] = vi.mocked(safeFetch).mock.calls[0]!;
    expect(url).toBe('https://shop.example/');
    expect(options).toMatchObject({ userAgent: 'AuraLeadBot/1.0 (+https://app.example/docs/bot)', totalTimeoutMs: 8_000, maxBytes: 1024 * 1024 });
    expect(EMAIL_PAGE_LIMITS).toEqual({ totalTimeoutMs: 8_000, maxBytes: 1024 * 1024 });
  });

  it('passes the caller\'s abort signal through, so a cancelled run stops reading', async () => {
    const controller = new AbortController();
    await finderPageFetcher('https://app.example')('https://shop.example/', controller.signal);
    expect(vi.mocked(safeFetch).mock.calls[0]![1]).toMatchObject({ signal: controller.signal });
  });
});
