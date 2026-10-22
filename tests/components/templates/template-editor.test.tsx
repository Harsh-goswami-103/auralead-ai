/**
 * ADR-123 (slice F4): the template studio form.
 * - Category first: nothing else shows until Marketing or Utility is chosen; Marketing starts with
 *   the Stop quick reply (mapped to Stop messages); Utility asks when it is sent.
 * - The insert buttons put the next {{n}} at the caret and map it to its source; every variable
 *   gets a source and an example; the server's own checks show live (fix before submitting,
 *   warnings such as promotional words in a Utility template).
 * - Generate posts the person's category, language, trigger and purpose (DEMO: the local
 *   template, labelled as such) and fills the form; Save draft posts the draft with the CSRF header
 *   to /api/app/templates (new) or /api/app/templates/[id], then refreshes.
 * - The WhatsApp preview follows the form, showing example values for variables.
 * - Without an AI integration in LIVE the generate control is a configuration gate.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import { TemplateEditor, type TemplateEditorProps } from '@/components/templates/TemplateEditor';
import { defaultButtons, type TemplateDraft } from '@/lib/domain/template-authoring';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderEditor(over: Partial<TemplateEditorProps> = {}) {
  const onClose = vi.fn();
  render(
    <CsrfProvider token="csrf-token-f4">
      <TemplateEditor workspaceSlug="codecraft-web" businessName="Codecraft Web Studio" localGenerator aiGate={null} initial={{ id: null, draft: null, copyGeneratorLabel: null }} onClose={onClose} {...over} />
    </CsrfProvider>,
  );
  return { onClose };
}

const body = () => screen.getByLabelText('Message body') as HTMLTextAreaElement;
const lastJson = () => JSON.parse((fetchMock.mock.calls.at(-1) as [string, RequestInit])[1].body as string) as Record<string, unknown>;

describe('TemplateEditor', () => {
  it('asks for the category first; Marketing starts with the Stop quick reply', () => {
    renderEditor();
    expect(screen.queryByLabelText('Message body')).toBeNull();
    expect(screen.getByText(/Choose a category to start/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Marketing' }));
    expect(body()).toBeTruthy();
    const stopRow = document.querySelector('[data-button-row="QUICK_REPLY"]') as HTMLElement;
    expect((within(stopRow).getByLabelText('Button text') as HTMLInputElement).value).toBe('Stop');
    expect((within(stopRow).getByLabelText('When tapped') as HTMLSelectElement).value).toBe('STOP');
    expect(screen.queryByLabelText('Sent when')).toBeNull();
  });

  it('Utility asks when it is sent, drops the Stop button, and warns about promotional words', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('radio', { name: 'Utility' }));
    expect(document.querySelector('[data-button-row]')).toBeNull();
    expect(document.querySelector('[data-issue="UTILITY_TRIGGER_REQUIRED"]')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Sent when'), { target: { value: 'QUOTE_ISSUED' } });
    expect(document.querySelector('[data-issue="UTILITY_TRIGGER_REQUIRED"]')).toBeNull();
    fireEvent.change(body(), { target: { value: 'Your free launch offer is ready to view.' } });
    expect(document.querySelector('[data-warning="PROMOTIONAL_WORDS"]')?.textContent).toContain('“offer”');
  });

  it('inserts the next variable at the caret, maps it, asks for its example, and previews it', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('radio', { name: 'Marketing' }));
    fireEvent.change(body(), { target: { value: 'Hello , we build websites.' } });
    body().setSelectionRange(6, 6);
    fireEvent.click(screen.getByRole('button', { name: 'First name' }));
    expect(body().value).toBe('Hello {{1}}, we build websites.');
    body().setSelectionRange(body().value.length - 1, body().value.length - 1);
    fireEvent.click(screen.getByRole('button', { name: 'Your business name' }));
    expect(body().value).toBe('Hello {{1}}, we build websites {{2}}.');
    expect((screen.getByLabelText('What fills {{1}}') as HTMLSelectElement).value).toBe('lead.firstName');
    expect((screen.getByLabelText('What fills {{2}}') as HTMLSelectElement).value).toBe('workspace.name');
    expect((screen.getByLabelText('Example for {{2}}') as HTMLInputElement).value).toBe('Codecraft Web Studio');
    expect(document.querySelector('[data-issue="EXAMPLE_REQUIRED"]')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Example for {{1}}'), { target: { value: 'Ravi' } });
    const preview = document.querySelector('[data-preview-body]') as HTMLElement;
    expect(preview.textContent).toBe('Hello Ravi, we build websites Codecraft Web Studio.');
    expect(preview.querySelector('[data-preview-variable="1"]')?.getAttribute('title')).toBe('{{1}}: Customer first name');
  });

  it('generates copy with the person’s category (local template in DEMO) and fills the form', async () => {
    const draft: TemplateDraft = {
      category: 'MARKETING',
      language: 'en',
      name: 'website_intro_123',
      utilityTrigger: null,
      header: { format: 'TEXT', text: 'A website for your business', example: null },
      body: 'Hello {{1}}, this is {{2}}. Would you like to see our work?',
      variables: [
        { position: '1', source: 'lead.firstName', example: 'Ravi' },
        { position: '2', source: 'workspace.name', example: 'Codecraft Web Studio' },
      ],
      footer: 'Tap Stop to opt out',
      buttons: [...defaultButtons('MARKETING'), { type: 'QUICK_REPLY', text: 'See examples', intent: null }],
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ draft, generatorLabel: 'local-deterministic', modelId: 'local-deterministic-v1', warnings: [] }), { status: 200 }));
    renderEditor();
    fireEvent.click(screen.getByRole('radio', { name: 'Marketing' }));
    fireEvent.change(screen.getByLabelText(/What is this template for/), { target: { value: 'businesses without a website' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Generate with local template' }));
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/app/templates/generate');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-token-f4');
    expect(lastJson()).toEqual({ workspaceSlug: 'codecraft-web', category: 'MARKETING', language: 'en', utilityTrigger: null, purpose: 'businesses without a website', local: true });
    expect(body().value).toBe(draft.body);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('website_intro_123');
    expect(screen.getByText('Local template')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Review every line');
  });

  it('saves a new draft, then saves changes to the stored one', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ template: { id: 'tpl_1', name: 'site_intro' }, warnings: [] }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ template: { id: 'tpl_1', name: 'site_intro' }, warnings: [] }), { status: 200 }));
    const onSaved = vi.fn();
    renderEditor({ onSaved });
    fireEvent.click(screen.getByRole('radio', { name: 'Marketing' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'site_intro' } });
    fireEvent.change(body(), { target: { value: 'Hello there, we build websites.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/app/templates');
    expect(lastJson()).toMatchObject({ workspaceSlug: 'codecraft-web', category: 'MARKETING', name: 'site_intro', body: 'Hello there, we build websites.', buttons: defaultButtons('MARKETING'), copyGeneratorLabel: null });
    expect(onSaved).toHaveBeenCalledWith('tpl_1');
    expect(refresh).toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    });
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/app/templates/tpl_1');
  });

  it('shows a refused save with its reference', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'TEMPLATE_NAME_TAKEN', message: 'A template named site_intro already exists in this language. Choose another name.', reference: 'req_42' }), { status: 409 }));
    renderEditor({ initial: { id: 'tpl_9', draft: { ...emptyMarketing(), name: 'site_intro', body: 'Hello there.' }, copyGeneratorLabel: null } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/app/templates/tpl_9');
    expect(screen.getByRole('alert').textContent).toBe('A template named site_intro already exists in this language. Choose another name. Reference req_42.');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('LIVE without an AI integration: the generate control is a configuration gate and posts nothing', () => {
    renderEditor({ localGenerator: false, aiGate: { category: 'configuration', reason: 'Connect an AI integration (Anthropic or OpenAI) to generate copy, or write the template yourself.' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Marketing' }));
    const gated = screen.getByRole('button', { name: 'Generate with AI' });
    expect(gated.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(gated);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Connect an AI integration/)).toBeTruthy();
  });

  it('removes and adds buttons within Meta’s limits', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('radio', { name: 'Marketing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add website link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add website link' }));
    expect(screen.queryByRole('button', { name: 'Add website link' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add call button' }));
    expect(screen.queryByRole('button', { name: 'Add call button' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove button Stop' }));
    expect(document.querySelector('[data-warning="NO_STOP_BUTTON"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-preview-button]')).toHaveLength(3);
  });
});

function emptyMarketing(): TemplateDraft {
  return { category: 'MARKETING', language: 'en', name: '', utilityTrigger: null, header: { format: 'NONE' }, body: '', variables: [], footer: null, buttons: defaultButtons('MARKETING') };
}
