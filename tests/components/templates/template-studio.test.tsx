/**
 * ADR-123 (slice F4): the template studio list.
 * - Status is icon plus label (Draft, Submitting to Meta, Pending review, Approved, Rejected with
 *   Meta's reason); the DEMO integration carries the Simulated chip; who wrote the copy is shown.
 * - Actions by state: Edit, Submit for approval and Delete for a draft; Delete for a rejected one.
 *   Submit posts to /api/app/templates/[id]/submit with the CSRF header and refreshes.
 * - Gates (plan §12): permission without templates.manage; configuration in LIVE without a stored
 *   WhatsApp integration (New template) or without a verified one (Submit), with the setup link.
 * - The last failed submission is explained; while Meta (or the DEMO review) answers, the page
 *   re-reads itself every few seconds.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { CsrfProvider } from '@/components/patterns/csrf';
import { REFRESH_EVERY_MS, TemplateStudio, type StudioTemplate, type StudioView } from '@/components/templates/TemplateStudio';
import { defaultButtons } from '@/lib/domain/template-authoring';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function template(over: Partial<StudioTemplate> = {}): StudioTemplate {
  return {
    id: 'tpl_draft',
    name: 'website_intro',
    language: 'en',
    category: 'MARKETING',
    status: 'DRAFT',
    origin: 'AUTHORED',
    rejectedReason: null,
    utilityTrigger: null,
    copyGeneratorLabel: null,
    submittedAt: null,
    syncedAt: null,
    simulated: true,
    body: 'Hello {{1}}, we build websites for local businesses.',
    notSendable: null,
    editable: true,
    submittable: true,
    deletable: true,
    draft: { category: 'MARKETING', language: 'en', name: 'website_intro', utilityTrigger: null, header: { format: 'NONE' }, body: 'Hello {{1}}, we build websites for local businesses.', variables: [{ position: '1', source: 'lead.firstName', example: 'Ravi' }], footer: null, buttons: defaultButtons('MARKETING') },
    lastSubmit: null,
    ...over,
  };
}

function view(over: Partial<StudioView> = {}): StudioView {
  return {
    workspace: { name: 'Codecraft Web Studio', timezone: 'Asia/Kolkata' },
    mode: 'demo',
    canManage: true,
    whatsapp: { canDraft: true, canSubmit: true, problem: null },
    ai: { local: true, available: true },
    templates: [template()],
    media: [],
    ...over,
  };
}

function renderStudio(v: StudioView) {
  return render(
    <CsrfProvider token="csrf-token-studio">
      <TemplateStudio workspaceSlug="codecraft-web" view={v} />
    </CsrfProvider>,
  );
}

const row = (name: string) => document.querySelector(`[data-template="${name}"]`) as HTMLElement;

describe('TemplateStudio', () => {
  it('shows status as icon plus label, the Simulated chip and the copy’s generator', () => {
    renderStudio(
      view({
        templates: [
          template({ copyGeneratorLabel: 'local-deterministic' }),
          template({ id: 't2', name: 'quote_issued_update', status: 'APPROVED', category: 'UTILITY', utilityTrigger: 'QUOTE_ISSUED', editable: false, submittable: false, deletable: false, draft: null }),
          template({ id: 't3', name: 'festive_reject', status: 'REJECTED', rejectedReason: 'INVALID_FORMAT', editable: false, submittable: false }),
          template({ id: 't4', name: 'synced_one', origin: 'SYNCED', status: 'PAUSED', editable: false, submittable: false, deletable: false, draft: null }),
        ],
      }),
    );
    const draft = row('website_intro');
    expect(within(draft).getByText('Draft')).toBeTruthy();
    expect(draft.querySelector('[data-status-chip] svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(within(draft).getByText('Simulated')).toBeTruthy();
    expect(within(draft).getByText('Local template')).toBeTruthy();
    expect(within(row('quote_issued_update')).getByText('Approved')).toBeTruthy();
    expect(within(row('quote_issued_update')).getByText('Sent when: A quotation was issued')).toBeTruthy();
    expect(within(row('festive_reject')).getByText('Rejected')).toBeTruthy();
    expect(row('festive_reject').querySelector('[data-rejected-reason]')?.textContent).toBe("Meta's reason: INVALID_FORMAT");
    expect(within(row('synced_one')).getByText('Paused by Meta')).toBeTruthy();
    expect(screen.getByText(/Simulated: submissions go to a demo review/)).toBeTruthy();
  });

  it('actions follow the state: a draft can be edited, submitted and deleted; a rejected one deleted; an approved one nothing', () => {
    renderStudio(view({ templates: [template(), template({ id: 't3', name: 'festive_reject', status: 'REJECTED', editable: false, submittable: false })] }));
    expect(within(row('website_intro')).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(row('website_intro')).getByRole('button', { name: 'Submit for approval' })).toBeTruthy();
    expect(within(row('website_intro')).getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(within(row('festive_reject')).queryByRole('button', { name: 'Submit for approval' })).toBeNull();
    expect(within(row('festive_reject')).getByRole('button', { name: 'Delete' })).toBeTruthy();
    fireEvent.click(within(row('website_intro')).getByRole('button', { name: 'Edit' }));
    expect((screen.getByLabelText('Message body') as HTMLTextAreaElement).value).toBe('Hello {{1}}, we build websites for local businesses.');
  });

  it('submits with the CSRF header and refreshes; a refusal is shown with its reference', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ simulated: true, template: { status: 'PENDING' }, reviewAt: '2026-10-23T06:00:30.000Z' }), { status: 200 }));
    renderStudio(view());
    await act(async () => {
      fireEvent.click(within(row('website_intro')).getByRole('button', { name: 'Submit for approval' }));
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/app/templates/tpl_draft/submit');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-token-studio');
    expect(JSON.parse(init.body as string)).toEqual({ workspaceSlug: 'codecraft-web' });
    expect(toast.success).toHaveBeenCalledWith('Submitted to the simulated review', expect.objectContaining({ description: expect.stringContaining('No provider contacted') }));
    expect(refresh).toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Give an example value for {{1}}: WhatsApp reviews the template with it.', reference: 'req_7' }), { status: 422 }));
    await act(async () => {
      fireEvent.click(within(row('website_intro')).getByRole('button', { name: 'Submit for approval' }));
    });
    expect(toast.error).toHaveBeenCalledWith('Not submitted', { description: 'Give an example value for {{1}}: WhatsApp reviews the template with it. Reference req_7.' });
  });

  it('deletes after the confirmation, naming the workspace', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ deleted: true, templateId: 'tpl_draft' }), { status: 200 }));
    renderStudio(view());
    fireEvent.click(within(row('website_intro')).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Codecraft Web Studio/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete template' }));
    });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/app/templates/tpl_draft/delete');
    expect(refresh).toHaveBeenCalled();
  });

  it('without templates.manage: New template and Submit are permission gates; no edit or delete', () => {
    renderStudio(view({ canManage: false }));
    const gated = screen.getByRole('button', { name: 'New template' });
    expect(gated.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getAllByText(/does not include “Manage templates”/).length).toBeGreaterThan(0);
    expect(within(row('website_intro')).getByRole('button', { name: 'Submit for approval' }).getAttribute('aria-disabled')).toBe('true');
    expect(within(row('website_intro')).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(row('website_intro')).queryByRole('button', { name: 'Delete' })).toBeNull();
    fireEvent.click(gated);
    expect(screen.queryByLabelText('Category')).toBeNull();
  });

  it('LIVE without WhatsApp: New template is a configuration gate with the setup link; not verified: Submit is gated', () => {
    const { unmount } = renderStudio(view({ mode: 'live', whatsapp: { canDraft: false, canSubmit: false, problem: 'Set up WhatsApp first: templates belong to the WhatsApp Business Account.' }, templates: [], ai: { local: false, available: false } }));
    expect(screen.getByRole('button', { name: 'New template' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('link', { name: 'Open WhatsApp setup' }).getAttribute('href')).toBe('/dashboard/employee/codecraft-web/integrations/whatsapp');
    expect(screen.queryByText(/Simulated/)).toBeNull();
    unmount();
    renderStudio(view({ mode: 'live', whatsapp: { canDraft: true, canSubmit: false, problem: 'Connect and verify WhatsApp (Test connection) before submitting templates.' }, templates: [template({ simulated: false })] }));
    expect(screen.getByRole('button', { name: 'New template' }).getAttribute('aria-disabled')).toBeNull();
    expect(within(row('website_intro')).getByRole('button', { name: 'Submit for approval' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getAllByText(/Connect and verify WhatsApp/).length).toBeGreaterThan(0);
  });

  it('explains the last failed submission of a draft', () => {
    renderStudio(view({ templates: [template({ lastSubmit: { result: 'FAILED', outcome: 'NOT_CREATED', errorCode: 'PROVIDER_AUTH', message: 'Meta rejected the WhatsApp access token. Enter a new one in the WhatsApp setup, then submit again.', at: '2026-10-23T06:00:00.000Z' } })] }));
    expect(within(row('website_intro')).getByText(/Last submission .*: Meta rejected the WhatsApp access token/)).toBeTruthy();
  });

  it('re-reads the page while a submission waits for Meta or the DEMO review, and only then', () => {
    vi.useFakeTimers();
    const { unmount } = renderStudio(view({ templates: [template({ status: 'PENDING', editable: false, submittable: false, deletable: false })] }));
    vi.advanceTimersByTime(REFRESH_EVERY_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(2);
    unmount();
    refresh.mockReset();
    renderStudio(view());
    vi.advanceTimersByTime(REFRESH_EVERY_MS * 2);
    expect(refresh).not.toHaveBeenCalled();
  });
});
