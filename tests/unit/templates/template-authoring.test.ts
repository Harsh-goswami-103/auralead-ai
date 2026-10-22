/**
 * ADR-123 (slice F4): the template studio rules shared by the form and the service.
 * - Meta's rules: name a-z0-9_ up to 512, a template language code, header text <= 60 with at most
 *   one variable, body <= 1024 with {{1}}..{{n}} in order and never at the edges, footer <= 60
 *   without variables, at most 3 quick replies, 2 URL and 1 phone button, examples before submit.
 * - Studio rules: UTILITY needs a trigger and warns about promotional words; MARKETING carries a
 *   Stop quick reply (STOP payload) by default and warns without it; a header variable warns
 *   (this app does not fill it).
 * - Stored shape: Meta's components with examples, quick replies grouped first, the mapping's
 *   button indexes follow that order, and a stored draft reads back to the same draft.
 */
import { describe, expect, it } from 'vitest';
import {
  alignedVariables,
  checkTemplateDraft,
  defaultButtons,
  draftFromStored,
  emptyDraft,
  positionalVariables,
  promotionalWordsIn,
  suggestTemplateName,
  templateComponentsOf,
  templateMappingOf,
  authoredVariableSchema,
  withCategory,
  type TemplateDraft,
} from '@/lib/domain/template-authoring';
import { templateShape } from '@/lib/domain/whatsapp-templates';

function draft(over: Partial<TemplateDraft> = {}): TemplateDraft {
  return {
    category: 'MARKETING',
    language: 'en',
    name: 'website_intro',
    utilityTrigger: null,
    header: { format: 'NONE' },
    body: 'Hello {{1}}, {{2}} builds fast websites for businesses like yours. Reply to know more.',
    variables: [
      { position: '1', source: 'lead.firstName', example: 'Ravi' },
      { position: '2', source: 'workspace.name', example: 'Codecraft Web Studio' },
    ],
    footer: 'Reply STOP to opt out',
    buttons: defaultButtons('MARKETING'),
    ...over,
  };
}

const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code);

describe('checkTemplateDraft: Meta rules', () => {
  it('accepts a complete marketing draft for saving and for submission', () => {
    expect(checkTemplateDraft(draft(), { forSubmit: false })).toEqual({ ok: true, errors: [], warnings: [] });
    expect(checkTemplateDraft(draft(), { forSubmit: true })).toMatchObject({ ok: true, errors: [] });
  });

  it('names: required, lowercase a-z0-9_ only, at most 512 characters', () => {
    expect(codes(checkTemplateDraft(draft({ name: '' }), { forSubmit: false }).errors)).toEqual(['NAME_REQUIRED']);
    expect(codes(checkTemplateDraft(draft({ name: 'Website Intro' }), { forSubmit: false }).errors)).toEqual(['NAME_FORMAT']);
    expect(codes(checkTemplateDraft(draft({ name: 'site-intro' }), { forSubmit: false }).errors)).toEqual(['NAME_FORMAT']);
    expect(codes(checkTemplateDraft(draft({ name: 'a'.repeat(512) }), { forSubmit: false }).errors)).toEqual([]);
    expect(codes(checkTemplateDraft(draft({ name: 'a'.repeat(513) }), { forSubmit: false }).errors)).toEqual(['NAME_TOO_LONG']);
  });

  it('languages: only template language codes', () => {
    expect(checkTemplateDraft(draft({ language: 'en_US' }), { forSubmit: false }).ok).toBe(true);
    expect(checkTemplateDraft(draft({ language: 'hi' }), { forSubmit: false }).ok).toBe(true);
    expect(codes(checkTemplateDraft(draft({ language: 'english' }), { forSubmit: false }).errors)).toEqual(['LANGUAGE_UNSUPPORTED']);
    expect(codes(checkTemplateDraft(draft({ language: 'en-US' }), { forSubmit: false }).errors)).toEqual(['LANGUAGE_UNSUPPORTED']);
  });

  it('header text: required when chosen, at most 60 characters, at most one variable ({{1}}), example before submit', () => {
    const text = (t: string, example: string | null = null) => draft({ header: { format: 'TEXT', text: t, example } });
    expect(codes(checkTemplateDraft(text(''), { forSubmit: false }).errors)).toEqual(['HEADER_TEXT_REQUIRED']);
    expect(codes(checkTemplateDraft(text('x'.repeat(60)), { forSubmit: false }).errors)).toEqual([]);
    expect(codes(checkTemplateDraft(text('x'.repeat(61)), { forSubmit: false }).errors)).toEqual(['HEADER_TEXT_TOO_LONG']);
    expect(codes(checkTemplateDraft(text('Hi {{1}} and {{2}}'), { forSubmit: false }).errors)).toEqual(['HEADER_TOO_MANY_VARIABLES']);
    expect(codes(checkTemplateDraft(text('Hi {{1}} {{1}}'), { forSubmit: false }).errors)).toEqual(['HEADER_TOO_MANY_VARIABLES']);
    expect(codes(checkTemplateDraft(text('Hi {{2}}'), { forSubmit: false }).errors)).toEqual(['HEADER_VARIABLE_NUMBER']);
    expect(codes(checkTemplateDraft(text('Hi {{name}}'), { forSubmit: false }).errors)).toEqual(['HEADER_NAMED_VARIABLE']);
    const oneVar = checkTemplateDraft(text('Hi {{1}}'), { forSubmit: true });
    expect(codes(oneVar.errors)).toEqual(['HEADER_EXAMPLE_REQUIRED']);
    expect(codes(oneVar.warnings)).toEqual(['HEADER_VARIABLE_NOT_SENDABLE']);
    expect(codes(checkTemplateDraft(text('Hi {{1}}', 'Ravi'), { forSubmit: true }).errors)).toEqual([]);
  });

  it('body: required, at most 1024 characters, positional variables in order, never at the start or end', () => {
    const body = (b: string, variables: TemplateDraft['variables'] = []) => checkTemplateDraft(draft({ body: b, variables }), { forSubmit: false });
    expect(codes(body('').errors)).toEqual(['BODY_REQUIRED']);
    expect(codes(body('x'.repeat(1024)).errors)).toEqual([]);
    expect(codes(body('x'.repeat(1025)).errors)).toEqual(['BODY_TOO_LONG']);
    expect(codes(body('Hello {{1}} and {{3}} here').errors)).toEqual(['BODY_VARIABLES_NOT_SEQUENTIAL']);
    expect(codes(body('Hello {{2}} here').errors)).toEqual(['BODY_VARIABLES_NOT_SEQUENTIAL']);
    expect(codes(body('Hello {{name}} here').errors)).toEqual(['BODY_NAMED_VARIABLE']);
    expect(codes(body('Hello {{1.5}} here').errors)).toEqual(['BODY_VARIABLE_FORMAT']);
    expect(codes(body('{{1}}, your site is ready').errors)).toEqual(['BODY_VARIABLE_AT_EDGE']);
    expect(codes(body('Your site is ready, {{1}}.').errors)).toEqual(['BODY_VARIABLE_AT_EDGE']);
    expect(codes(body('Hi {{1}}, then {{2}} and {{1}} again.').errors)).toEqual([]);
    const many = Array.from({ length: 11 }, (_, i) => `{{${i + 1}}}`).join(' a ');
    expect(codes(body(`Start ${many} end`).errors)).toEqual(['BODY_TOO_MANY_VARIABLES']);
  });

  it('examples: one line, at most 200 characters, required for every variable before submission', () => {
    const missing = checkTemplateDraft(draft({ variables: [{ position: '1', source: 'lead.firstName', example: 'Ravi' }] }), { forSubmit: true });
    expect(missing.errors).toEqual([expect.objectContaining({ field: 'variables.2', code: 'EXAMPLE_REQUIRED' })]);
    expect(checkTemplateDraft(draft({ variables: [] }), { forSubmit: false }).ok).toBe(true);
    const newline = draft({ variables: [{ position: '1', source: 'manual', example: 'two\nlines' }, { position: '2', source: 'manual', example: 'x' }] });
    expect(codes(checkTemplateDraft(newline, { forSubmit: false }).errors)).toEqual(['EXAMPLE_FORMAT']);
    const long = draft({ variables: [{ position: '1', source: 'manual', example: 'x'.repeat(201) }, { position: '2', source: 'manual', example: 'x' }] });
    expect(codes(checkTemplateDraft(long, { forSubmit: false }).errors)).toEqual(['EXAMPLE_TOO_LONG']);
  });

  it('footer: at most 60 characters, no variables', () => {
    expect(codes(checkTemplateDraft(draft({ footer: 'x'.repeat(61) }), { forSubmit: false }).errors)).toEqual(['FOOTER_TOO_LONG']);
    expect(codes(checkTemplateDraft(draft({ footer: 'Hi {{1}}' }), { forSubmit: false }).errors)).toEqual(['FOOTER_VARIABLE']);
    expect(checkTemplateDraft(draft({ footer: null }), { forSubmit: false }).ok).toBe(true);
  });

  it('buttons: at most 3 quick replies, 2 URL and 1 phone; text <= 25, unique; static https links; E.164 numbers', () => {
    const qr = (text: string) => ({ type: 'QUICK_REPLY' as const, text, intent: null });
    const url = (text: string, u = 'https://codecraft.example/work') => ({ type: 'URL' as const, text, url: u });
    const phone = (text: string, n = '+919876543210') => ({ type: 'PHONE_NUMBER' as const, text, phoneNumber: n });
    const check = (buttons: TemplateDraft['buttons']) => codes(checkTemplateDraft(draft({ buttons }), { forSubmit: false }).errors);
    expect(check([qr('Stop'), qr('Get a quote'), qr('Call me'), url('See our work'), url('Pricing page'), phone('Call us')])).toEqual([]);
    expect(check([qr('a'), qr('b'), qr('c'), qr('d')])).toEqual(['TOO_MANY_QUICK_REPLIES']);
    expect(check([url('a'), url('b'), url('c')])).toEqual(['TOO_MANY_URL_BUTTONS']);
    expect(check([phone('a'), phone('b')])).toEqual(['TOO_MANY_PHONE_BUTTONS']);
    expect(check([qr('')])).toEqual(['BUTTON_TEXT_REQUIRED']);
    expect(check([qr('x'.repeat(26))])).toEqual(['BUTTON_TEXT_TOO_LONG']);
    expect(check([qr('Stop'), qr('stop')])).toEqual(['BUTTON_TEXT_DUPLICATE']);
    expect(check([url('Site', 'http://codecraft.example')])).toEqual(['URL_INVALID']);
    expect(check([url('Site', 'https://codecraft.example/{{1}}')])).toEqual(['URL_VARIABLE']);
    expect(check([phone('Call', '9876543210')])).toEqual(['PHONE_INVALID']);
  });
});

describe('checkTemplateDraft: studio rules (ADR-123)', () => {
  it('UTILITY needs a "sent when" trigger', () => {
    const utility = draft({ category: 'UTILITY', buttons: [], footer: null, body: 'Hello {{1}}, here is the project update you asked for from {{2}} today.' });
    expect(codes(checkTemplateDraft(utility, { forSubmit: false }).errors)).toEqual(['UTILITY_TRIGGER_REQUIRED']);
    expect(checkTemplateDraft({ ...utility, utilityTrigger: 'CUSTOMER_ASKED' }, { forSubmit: true })).toMatchObject({ ok: true, warnings: [] });
  });

  it('UTILITY warns about promotional words (never blocks)', () => {
    const promo = draft({ category: 'UTILITY', utilityTrigger: 'CUSTOMER_ASKED', buttons: [], footer: null, body: 'Hello {{1}}, our launch offer: a free brochure from {{2}} today.' });
    const result = checkTemplateDraft(promo, { forSubmit: true });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'PROMOTIONAL_WORDS' })]);
    expect(result.warnings[0]!.message).toContain('“offer”');
    expect(promotionalWordsIn('Feel free to reply with questions.')).toEqual([]);
    expect(promotionalWordsIn('Get 20% off and a discount')).toEqual(['discount', '% off']);
    expect(promotionalWordsIn('The project plan is attached.')).toEqual([]);
  });

  it('MARKETING carries the Stop quick reply (STOP payload) by default and warns without it', () => {
    expect(defaultButtons('MARKETING')).toEqual([{ type: 'QUICK_REPLY', text: 'Stop', intent: 'STOP' }]);
    expect(defaultButtons('UTILITY')).toEqual([]);
    expect(emptyDraft('MARKETING').buttons).toEqual(defaultButtons('MARKETING'));
    expect(codes(checkTemplateDraft(draft({ buttons: [] }), { forSubmit: false }).warnings)).toEqual(['NO_STOP_BUTTON']);
  });

  it('switching category moves the Stop button and the trigger with it', () => {
    const marketing = draft();
    const utility = withCategory(marketing, 'UTILITY');
    expect(utility.buttons).toEqual([]);
    expect(utility.utilityTrigger).toBeNull();
    const back = withCategory({ ...utility, utilityTrigger: 'QUOTE_ISSUED', buttons: [{ type: 'QUICK_REPLY', text: 'Call me', intent: 'CALL' }] }, 'MARKETING');
    expect(back.buttons).toEqual([{ type: 'QUICK_REPLY', text: 'Stop', intent: 'STOP' }, { type: 'QUICK_REPLY', text: 'Call me', intent: 'CALL' }]);
    expect(back.utilityTrigger).toBeNull();
  });
});

describe('stored shape', () => {
  it('components follow Meta’s create shape with examples; quick replies grouped first; mapping indexes follow', () => {
    const d = draft({
      header: { format: 'TEXT', text: 'A website for your business', example: null },
      buttons: [{ type: 'URL', text: 'See our work', url: 'https://codecraft.example/work' }, { type: 'QUICK_REPLY', text: 'Stop', intent: 'STOP' }, { type: 'PHONE_NUMBER', text: 'Call us', phoneNumber: '+919876543210' }],
    });
    expect(templateComponentsOf(d)).toEqual([
      { type: 'HEADER', format: 'TEXT', text: 'A website for your business' },
      { type: 'BODY', text: d.body, example: { body_text: [['Ravi', 'Codecraft Web Studio']] } },
      { type: 'FOOTER', text: 'Reply STOP to opt out' },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Stop' },
          { type: 'URL', text: 'See our work', url: 'https://codecraft.example/work' },
          { type: 'PHONE_NUMBER', text: 'Call us', phone_number: '+919876543210' },
        ],
      },
    ]);
    expect(templateMappingOf(d)).toEqual({ body: { '1': 'lead.firstName', '2': 'workspace.name' }, buttons: { '0': 'STOP' } });
    expect(authoredVariableSchema(d)).toEqual([
      { name: '1', component: 'BODY', source: 'lead.firstName', example: 'Ravi' },
      { name: '2', component: 'BODY', source: 'workspace.name', example: 'Codecraft Web Studio' },
    ]);
    // The send path reads the same components: two body variables, the Stop quick reply at index 0, sendable.
    expect(templateShape(templateComponentsOf(d))).toMatchObject({ bodyVariables: ['1', '2'], quickReplies: [{ index: 0, text: 'Stop' }], sendable: { ok: true } });
  });

  it('a header variable example and a document header handle are carried in the example block', () => {
    expect(templateComponentsOf(draft({ header: { format: 'TEXT', text: 'Hi {{1}}', example: 'Ravi' } }))[0]).toEqual({ type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}', example: { header_text: ['Ravi'] } });
    expect(templateComponentsOf(draft({ header: { format: 'DOCUMENT', mediaId: 'm1' } }))[0]).toEqual({ type: 'HEADER', format: 'DOCUMENT' });
    expect(templateComponentsOf(draft({ header: { format: 'DOCUMENT', mediaId: 'm1' } }), { headerHandle: '4::aGVsbG8=' })[0]).toEqual({ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: ['4::aGVsbG8='] } });
  });

  it('variables align to the body: unknown positions dropped, missing ones manual without an example', () => {
    expect(alignedVariables({ body: 'Hi {{1}} and {{2}} ok', variables: [{ position: '2', source: 'lead.city', example: 'Indore' }, { position: '7', source: 'lead.city', example: 'x' }] })).toEqual([
      { position: '1', source: 'manual', example: '' },
      { position: '2', source: 'lead.city', example: 'Indore' },
    ]);
    expect(positionalVariables('{{ 2 }} and {{1}} and {{2}}')).toEqual(['1', '2']);
  });

  it('a stored authored template reads back to the same draft', () => {
    const d = draft({
      header: { format: 'TEXT', text: 'Websites in {{1}}', example: 'Indore' },
      buttons: [{ type: 'QUICK_REPLY', text: 'Stop', intent: 'STOP' }, { type: 'QUICK_REPLY', text: 'Get a quote', intent: 'QUOTE' }, { type: 'URL', text: 'See our work', url: 'https://codecraft.example/work' }],
    });
    const stored = { name: d.name, language: d.language, category: 'MARKETING', components: templateComponentsOf(d), variableSchema: authoredVariableSchema(d), variableMap: templateMappingOf(d), utilityTrigger: null, headerMediaId: null };
    expect(draftFromStored(stored)).toEqual(d);
    const utility = draft({ category: 'UTILITY', utilityTrigger: 'MEETING_BOOKED', buttons: [], header: { format: 'DOCUMENT', mediaId: 'media_1' } });
    expect(draftFromStored({ ...stored, category: 'UTILITY', components: templateComponentsOf(utility), utilityTrigger: 'MEETING_BOOKED', headerMediaId: 'media_1' })).toEqual(utility);
  });

  it('suggests a valid name from free text', () => {
    expect(suggestTemplateName('Website Intro – Indore!')).toBe('website_intro_indore');
    expect(checkTemplateDraft(draft({ name: suggestTemplateName('Brochure for new leads') }), { forSubmit: false }).ok).toBe(true);
  });
});
