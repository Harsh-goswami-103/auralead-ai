/**
 * ADR-123 (slice F4, P1): which document fills a template's DOCUMENT header. With the template's
 * own brochure (`headerMediaId`) it is that PDF (`media`); without one it is the quotation PDF the
 * send carries (`quote`, P2, unchanged); a template without a document header has none. The rule
 * changes nothing else about sendability.
 */
import { describe, expect, it } from 'vitest';
import { templateShape } from '@/lib/domain/whatsapp-templates';

const DOC = [{ type: 'HEADER', format: 'DOCUMENT' }, { type: 'BODY', text: 'Hello {{1}}, our brochure is attached. Reply to know more.' }];

describe('templateShape documentSource', () => {
  it('a DOCUMENT header is the brochure with headerMediaId, else the quote PDF', () => {
    expect(templateShape(DOC, null, { headerMediaId: 'med1' })).toMatchObject({ documentHeader: true, documentSource: 'media', sendable: { ok: true }, bodyVariables: ['1'] });
    expect(templateShape(DOC)).toMatchObject({ documentHeader: true, documentSource: 'quote', sendable: { ok: true } });
    expect(templateShape(DOC, null, { headerMediaId: null })).toMatchObject({ documentSource: 'quote' });
  });

  it('no document header: no document source, whatever the media id', () => {
    expect(templateShape([{ type: 'BODY', text: 'Hi there' }], null, { headerMediaId: 'med1' })).toMatchObject({ documentHeader: false, documentSource: null });
    expect(templateShape([{ type: 'HEADER', format: 'TEXT', text: 'Hi' }, { type: 'BODY', text: 'Hi there' }], null, { headerMediaId: 'med1' })).toMatchObject({ documentSource: null });
    expect(templateShape([{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hi there' }], null, { headerMediaId: 'med1' })).toMatchObject({ documentSource: null, sendable: { ok: false, reason: 'MEDIA_HEADER' } });
  });
});
