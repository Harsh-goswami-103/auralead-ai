// T28 integration catalog: one entry per IntegrationKind (plan §5.1), unique URL slugs that round
// trip, credential field names the rest of the system reads (the AI selection decrypts
// `secrets.apiKey`, ADR-55), a DEMO note for every provider, and webhook paths only where the
// verified receiver exists (WhatsApp, T20).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IntegrationKind } from '@/lib/domain/enums';
import { catalogEntry, INTEGRATION_CATALOG, INTEGRATION_KIND_ORDER, integrationKindFromSlug, integrationSlug } from '@/lib/domain/integrations';

const ROOT = path.resolve(__dirname, '../../..');

describe('integration catalog', () => {
  it('has exactly one entry per IntegrationKind', () => {
    expect([...INTEGRATION_KIND_ORDER].sort()).toEqual([...IntegrationKind].sort());
    expect(new Set(INTEGRATION_CATALOG.map((e) => e.kind)).size).toBe(INTEGRATION_CATALOG.length);
  });

  it('slugs are unique, URL-safe and round trip', () => {
    const slugs = INTEGRATION_CATALOG.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const kind of IntegrationKind) {
      const slug = integrationSlug(kind);
      expect(slug).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(integrationKindFromSlug(slug)).toBe(kind);
    }
    expect(integrationKindFromSlug('telegram')).toBeNull();
    expect(integrationKindFromSlug('WHATSAPP_CLOUD')).toBeNull();
  });

  it('names the credential keys the adapters read and a DEMO note for every provider', () => {
    expect(catalogEntry('AI_ANTHROPIC').credentialFields.map((f) => f.key)).toEqual(['apiKey']);
    expect(catalogEntry('AI_OPENAI').credentialFields.map((f) => f.key)).toEqual(['apiKey']);
    expect(catalogEntry('AI_ANTHROPIC').configFields.map((f) => f.key)).toEqual(['modelId']);
    for (const e of INTEGRATION_CATALOG) {
      expect(e.credentialFields.length).toBeGreaterThan(0);
      expect(e.demoNote).toMatch(/never contacted|No mail server is contacted/);
      expect(e.prerequisites.length).toBeGreaterThan(0);
      for (const f of [...e.configFields, ...e.credentialFields]) expect(f.key).toMatch(/^[a-z][A-Za-z0-9]*$/);
    }
  });

  it('lists a webhook path only where the receiver route exists', () => {
    for (const e of INTEGRATION_CATALOG) {
      if (e.webhookPath === null) continue;
      expect(existsSync(path.join(ROOT, 'src/app', ...e.webhookPath.split('/').filter(Boolean), 'route.ts')), e.webhookPath).toBe(true);
    }
    expect(catalogEntry('WHATSAPP_CLOUD').webhookPath).toBe('/api/webhooks/whatsapp');
  });
});
