/**
 * Per-lead template variables (ADR-123, lead-gen plan §4 B3): the lead and workspace sources a
 * template body position may be mapped to, and the pure resolver bulk sends and the composer use.
 * Missing values are reported, never invented.
 */
import { describe, expect, it } from 'vitest';
import { TemplateMappingBody } from '@/lib/schemas/integrations';
import {
  isLeadTemplateVariableSource,
  isTemplateVariableSource,
  LEAD_TEMPLATE_VARIABLE_SOURCES,
  leadFirstName,
  parseTemplateMapping,
  resolveLeadTemplateVariables,
  TEMPLATE_VARIABLE_MAX_LENGTH,
  TEMPLATE_VARIABLE_SOURCES,
  templateShape,
} from '@/lib/domain/whatsapp-templates';

const lead = { displayName: 'Priya Sharma', city: 'Indore', category: 'Dental clinic' };
const workspace = { name: 'Codecraft Web Studio' };

describe('template variable sources', () => {
  it('offer the lead-gen per-lead sources next to the existing ones', () => {
    for (const source of ['lead.firstName', 'lead.displayName', 'lead.city', 'lead.category', 'workspace.name', 'quote.number', 'ai.firstTouch', 'manual']) {
      expect(isTemplateVariableSource(source), source).toBe(true);
      expect(TEMPLATE_VARIABLE_SOURCES[source as keyof typeof TEMPLATE_VARIABLE_SOURCES].length, source).toBeGreaterThan(0);
    }
    expect(isTemplateVariableSource('lead.phone')).toBe(false);
    expect(isTemplateVariableSource('toString')).toBe(false);
  });

  it('name exactly the five sources a lead and its workspace resolve, none of them contact data', () => {
    expect([...LEAD_TEMPLATE_VARIABLE_SOURCES]).toEqual(['lead.firstName', 'lead.displayName', 'lead.city', 'lead.category', 'workspace.name']);
    for (const source of LEAD_TEMPLATE_VARIABLE_SOURCES) {
      expect(isTemplateVariableSource(source)).toBe(true);
      expect(isLeadTemplateVariableSource(source)).toBe(true);
    }
    for (const source of ['manual', 'quote.number', 'quote.total', 'quote.validUntil', 'ai.firstTouch', 'lead.phone']) expect(isLeadTemplateVariableSource(source), source).toBe(false);
  });

  it('parseTemplateMapping keeps the new sources (nested and the T28 flat shape)', () => {
    const nested = parseTemplateMapping({ body: { '1': 'lead.firstName', '2': 'lead.city', '3': 'lead.category', '4': 'workspace.name', '5': 'lead.phone' }, buttons: { '0': 'STOP' } });
    expect(nested).toEqual({ body: { '1': 'lead.firstName', '2': 'lead.city', '3': 'lead.category', '4': 'workspace.name' }, buttons: { '0': 'STOP' } });
    expect(parseTemplateMapping({ '01': 'lead.firstName', '2': 'lead.displayName' }).body).toEqual({ '1': 'lead.firstName', '2': 'lead.displayName' });
  });

  it('the mapping body schema accepts the new sources and refuses unknown ones', () => {
    expect(TemplateMappingBody.safeParse({ workspaceSlug: 'codecraft-web', intent: 'FIRST_TOUCH', variables: { '1': 'lead.firstName', '2': 'lead.city' } }).success).toBe(true);
    expect(TemplateMappingBody.safeParse({ workspaceSlug: 'codecraft-web', intent: 'FIRST_TOUCH', variables: { '1': 'lead.phone' } }).success).toBe(false);
  });
});

describe('leadFirstName', () => {
  it.each([
    ['Priya Sharma', 'Priya'],
    ['  priya   sharma ', 'priya'],
    ['Dr. Priya Sharma', 'Priya'],
    ['Mr Rahul Verma', 'Rahul'],
    ['Smt. Kavita Joshi', 'Kavita'],
    ["D'Souza Bakers", "D'Souza"],
    ['Anne-Marie Fernandes', 'Anne-Marie'],
    ['राहुल वर्मा', 'राहुल'],
    ['Rahul, Verma', 'Rahul'],
  ])('%s -> %s', (name, first) => {
    expect(leadFirstName(name)).toBe(first);
  });

  it.each([[''], ['   '], ['Dr.'], ['The Bake House'], ['123 Traders'], [null], [undefined]])('has no first name for %j', (name) => {
    expect(leadFirstName(name)).toBeNull();
  });
});

describe('resolveLeadTemplateVariables', () => {
  it('fills every lead and workspace source by position', () => {
    const result = resolveLeadTemplateVariables(
      { positions: ['1', '2', '3', '4', '5'], sources: { '1': 'lead.firstName', '2': 'lead.displayName', '3': 'lead.city', '4': 'lead.category', '5': 'workspace.name' } },
      lead,
      workspace,
    );
    expect(result).toEqual({ ok: true, values: { '1': 'Priya', '2': 'Priya Sharma', '3': 'Indore', '4': 'Dental clinic', '5': 'Codecraft Web Studio' }, missing: [] });
  });

  it('keeps literal values for manual and unmapped positions', () => {
    const result = resolveLeadTemplateVariables({ positions: ['1', '2', '3'], sources: { '1': 'lead.firstName', '2': 'manual' }, literals: { '2': 'website redesign', '3': 'this week' } }, lead, workspace);
    expect(result).toEqual({ ok: true, values: { '1': 'Priya', '2': 'website redesign', '3': 'this week' }, missing: [] });
  });

  it('lets a lead source win over a literal for the same position (per-lead values stay per lead)', () => {
    const result = resolveLeadTemplateVariables({ positions: ['1'], sources: { '1': 'lead.city' }, literals: { '1': 'Mumbai' } }, lead, workspace);
    expect(result.values).toEqual({ '1': 'Indore' });
  });

  it('uses a caller-provided literal for sources it cannot see (quote, AI) and reports them otherwise', () => {
    expect(resolveLeadTemplateVariables({ positions: ['1', '2'], sources: { '1': 'quote.number', '2': 'ai.firstTouch' }, literals: { '1': 'Q-0007' } }, lead, workspace)).toEqual({
      ok: false,
      values: { '1': 'Q-0007' },
      missing: [{ position: '2', source: 'ai.firstTouch', reason: 'NEEDS_CONTEXT' }],
    });
  });

  it('reports missing values and never invents one', () => {
    const bare = { displayName: 'The Bake House', city: null, category: '   ' };
    const result = resolveLeadTemplateVariables(
      { positions: ['1', '2', '3', '4', '5'], sources: { '1': 'lead.firstName', '2': 'lead.city', '3': 'lead.category', '4': 'manual', '5': 'workspace.name' }, literals: { '4': '  ' } },
      bare,
      { name: '' },
    );
    expect(result).toEqual({
      ok: false,
      values: {},
      missing: [
        { position: '1', source: 'lead.firstName', reason: 'NO_VALUE' },
        { position: '2', source: 'lead.city', reason: 'NO_VALUE' },
        { position: '3', source: 'lead.category', reason: 'NO_VALUE' },
        { position: '4', source: 'manual', reason: 'NOT_PROVIDED' },
        { position: '5', source: 'workspace.name', reason: 'NO_VALUE' },
      ],
    });
  });

  it('folds newlines, tabs and runs of spaces (a provider rejects them in a parameter) without changing the words', () => {
    const result = resolveLeadTemplateVariables(
      { positions: ['1', '2'], sources: { '1': 'lead.displayName', '2': 'manual' }, literals: { '2': ' line one\n\tline     two ' } },
      { displayName: 'Sharma\tDental    Clinic', city: null, category: null },
      workspace,
    );
    expect(result).toEqual({ ok: true, values: { '1': 'Sharma Dental Clinic', '2': 'line one line two' }, missing: [] });
  });

  it('reports a value longer than the parameter limit instead of cutting it', () => {
    const long = 'x'.repeat(TEMPLATE_VARIABLE_MAX_LENGTH + 1);
    expect(TEMPLATE_VARIABLE_MAX_LENGTH).toBe(200);
    const result = resolveLeadTemplateVariables({ positions: ['1', '2'], sources: { '1': 'lead.category', '2': 'manual' }, literals: { '2': 'y'.repeat(TEMPLATE_VARIABLE_MAX_LENGTH) } }, { displayName: 'A', city: null, category: long }, workspace);
    expect(result).toEqual({ ok: false, values: { '2': 'y'.repeat(TEMPLATE_VARIABLE_MAX_LENGTH) }, missing: [{ position: '1', source: 'lead.category', reason: 'TOO_LONG' }] });
  });

  it('answers only the positions asked for, in numeric order, ignoring sources and literals for other positions', () => {
    const result = resolveLeadTemplateVariables({ positions: ['10', '2'], sources: { '2': 'lead.city', '7': 'lead.category', '10': 'workspace.name' }, literals: { '9': 'stray' } }, lead, workspace);
    expect(result).toEqual({ ok: true, values: { '2': 'Indore', '10': 'Codecraft Web Studio' }, missing: [] });
    expect(Object.keys(result.values)).toEqual(['2', '10']);
    expect(resolveLeadTemplateVariables({ positions: [], sources: { '1': 'lead.city' } }, lead, workspace)).toEqual({ ok: true, values: {}, missing: [] });
  });

  it('works end to end with a template shape and its stored mapping', () => {
    const components = [{ type: 'BODY', text: 'Hi {{1}}, we build websites for {{2}} businesses in {{3}}. {{4}}' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Stop' }] }];
    const shape = templateShape(components);
    const mapping = parseTemplateMapping({ body: { '1': 'lead.firstName', '2': 'lead.category', '3': 'lead.city', '4': 'manual' }, buttons: { '0': 'STOP' } });
    const result = resolveLeadTemplateVariables({ positions: shape.bodyVariables, sources: mapping.body, literals: { '4': 'Reply YES for a free audit.' } }, lead, workspace);
    expect(result).toEqual({ ok: true, values: { '1': 'Priya', '2': 'Dental clinic', '3': 'Indore', '4': 'Reply YES for a free audit.' }, missing: [] });
  });
});
