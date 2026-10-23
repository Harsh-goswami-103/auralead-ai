/**
 * Lead-gen F5 (ADR-125): the reach-out panel on the operator's lead page.
 * - The WhatsApp state is icon + label + what it allows.
 * - "Record WhatsApp opt-in" opens a form with the notice prefilled from the workspace, the method,
 *   the time and a note, and posts a WHATSAPP MARKETING opt-in with the CSRF header; a 422 (the
 *   notice does not name the business) stays on the form with its reference; success says whether
 *   an earlier STOP was cleared. Without leads.write, or without a phone number, it is gated.
 * - The click-to-chat link with Copy; "Update link" asks the server, which refuses a keyword.
 *   Without a WhatsApp number it is a configuration gate with the fix link.
 * - The workspace notice form (automation.manage only) saves the notice and the privacy contact.
 * - After the handoff the panel is read-only.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import { ClickToChatLink, RecordOptInForm, ReachOutSettingsForm } from '@/components/reach-out/ReachOutForms';
import { ReachOutPanel } from '@/components/reach-out/ReachOutPanel';
import type { ConsentChannelDto } from '@/lib/schemas/leads';
import type { ReachOutDto } from '@/lib/schemas/reach-out';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

afterEach(() => {
  cleanup();
  refresh.mockReset();
  toast.success.mockReset();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(...responses: Array<() => Response>) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: init.headers as Record<string, string> });
      const next = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      return next();
    }),
  );
  return calls;
}

const withCsrf = (el: React.ReactElement) => render(<CsrfProvider token="csrf-token">{el}</CsrfProvider>);
const NOTICE = 'I agree to receive WhatsApp messages from Codecraft Web Studio about its services. I can reply STOP at any time.';

describe('RecordOptInForm', () => {
  it('opens prefilled and posts a WhatsApp MARKETING opt-in with the method, time, note and notice', async () => {
    const calls = stubFetch(() => json({ consentId: 'c1', reoptIn: 'CLEARED' }));
    withCsrf(<RecordOptInForm leadId="lead_1" workspaceSlug="codecraft-web" businessName="Codecraft Web Studio" noticePrefill={NOTICE} gate={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record WhatsApp opt-in' }));
    const form = screen.getByRole('form', { name: 'Record WhatsApp opt-in' });
    expect((within(form).getByLabelText('Notice the customer agreed to') as HTMLTextAreaElement).value).toBe(NOTICE);
    expect(form.textContent).toContain('It must name Codecraft Web Studio.');
    const when = within(form).getByLabelText('When they agreed') as HTMLInputElement;
    expect(when.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    fireEvent.change(when, { target: { value: '2026-10-22T15:30' } });
    fireEvent.change(within(form).getByLabelText('How the customer agreed'), { target: { value: 'CALL_VERBAL' } });
    fireEvent.change(within(form).getByLabelText('What happened'), { target: { value: 'Owner said yes on the call' } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/app/consent/grants');
    expect(calls[0]!.headers['x-csrf-token']).toBe('csrf-token');
    expect(calls[0]!.body).toEqual({
      workspaceSlug: 'codecraft-web',
      leadId: 'lead_1',
      channel: 'WHATSAPP',
      purpose: 'MARKETING',
      source: 'MANUAL_EVIDENCE',
      collectedAt: new Date('2026-10-22T15:30').toISOString(),
      evidence: { note: 'Owner said yes on the call', method: 'CALL_VERBAL' },
      noticeText: NOTICE,
    });
    expect(toast.success).toHaveBeenCalledWith('WhatsApp opt-in recorded. An earlier STOP was cleared, because this opt-in is newer.');
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole('form', { name: 'Record WhatsApp opt-in' })).toBeNull();
  });

  it('opens with the workspace notice as it is now, also when it was saved after the page loaded', () => {
    const props = { leadId: 'lead_1', workspaceSlug: 'codecraft-web', businessName: 'Codecraft Web Studio', gate: null } as const;
    const view = withCsrf(<RecordOptInForm {...props} noticePrefill={NOTICE} />);
    // The workspace notice form saved a new text; the page re-read itself and passes the new prefill.
    const saved = 'Codecraft Web Studio will send me WhatsApp offers about websites. I can reply STOP.';
    view.rerender(
      <CsrfProvider token="csrf-token">
        <RecordOptInForm {...props} noticePrefill={saved} />
      </CsrfProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Record WhatsApp opt-in' }));
    expect((screen.getByLabelText('Notice the customer agreed to') as HTMLTextAreaElement).value).toBe(saved);
  });

  it("a refusal stays on the form with the server's message and reference", async () => {
    stubFetch(() => json({ code: 'NOTICE_MISSING_BUSINESS_NAME', message: 'The notice must name the business ("Codecraft Web Studio").', reference: 'req_notice01' }, 422));
    withCsrf(<RecordOptInForm leadId="lead_1" workspaceSlug="codecraft-web" businessName="Codecraft Web Studio" noticePrefill={NOTICE} gate={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record WhatsApp opt-in' }));
    const form = screen.getByRole('form', { name: 'Record WhatsApp opt-in' });
    fireEvent.change(within(form).getByLabelText('Notice the customer agreed to'), { target: { value: 'Yes to WhatsApp offers.' } });
    fireEvent.change(within(form).getByLabelText('How the customer agreed'), { target: { value: 'IN_PERSON' } });
    fireEvent.change(within(form).getByLabelText('What happened'), { target: { value: 'Met at the expo' } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(within(form).getByRole('alert').textContent).toContain('The notice must name the business');
    expect(within(form).getByRole('alert').textContent).toContain('req_notice01');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('gated: the reason shows and no form opens', () => {
    withCsrf(<RecordOptInForm leadId="lead_1" workspaceSlug="codecraft-web" businessName="Codecraft Web Studio" noticePrefill={NOTICE} gate={{ category: 'eligibility', reason: 'This lead has no phone number.' }} />);
    const button = screen.getByRole('button', { name: 'Record WhatsApp opt-in' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.getByText('This lead has no phone number.')).toBeTruthy();
  });
});

describe('ClickToChatLink', () => {
  const LINK = 'https://wa.me/919812345678?text=Hi';
  it('shows the link with Copy; a keyword is refused by the server and the old link stays; a sentence updates it', async () => {
    const calls = stubFetch(
      () => json({ code: 'PREFILL_IS_KEYWORD', message: 'This text is a WhatsApp START or STOP keyword.', reference: 'req_kw01' }, 422),
      () => json({ link: 'https://wa.me/919812345678?text=Hello%20there', prefill: 'Hello there', displayPhoneNumber: '+919812345678' }),
    );
    withCsrf(<ClickToChatLink workspaceSlug="codecraft-web" link={LINK} prefill="Hi" displayPhoneNumber="+919812345678" simulated />);
    const link = screen.getByLabelText(/Click-to-chat link to \+919812345678/) as HTMLInputElement;
    expect(link.value).toBe(LINK);
    expect(link.readOnly).toBe(true);
    expect(screen.getByRole('button', { name: 'Copy click-to-chat link' })).toBeTruthy();
    expect(screen.getByText('Simulated')).toBeTruthy();

    const prefill = screen.getByLabelText('First message the customer sends');
    fireEvent.change(prefill, { target: { value: 'STOP' } });
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: 'First message' }));
    });
    expect(calls[0]).toMatchObject({ url: '/api/app/settings/reach-out/click-to-chat', body: { workspaceSlug: 'codecraft-web', prefill: 'STOP' } });
    expect(screen.getByRole('alert').textContent).toContain('START or STOP keyword');
    expect(link.value).toBe(LINK);

    fireEvent.change(prefill, { target: { value: 'Hello there' } });
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: 'First message' }));
    });
    expect(link.value).toBe('https://wa.me/919812345678?text=Hello%20there');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('ReachOutSettingsForm', () => {
  it('saves the notice and the privacy contact; empty values are sent as null', async () => {
    const calls = stubFetch(() => json({ whatsappOptInNotice: null, privacyContact: 'dpo@codecraft.example', changed: ['privacyContact'] }));
    withCsrf(<ReachOutSettingsForm workspaceSlug="codecraft-web" businessName="Codecraft Web Studio" notice={null} privacyContact={null} />);
    fireEvent.change(screen.getByLabelText('Privacy contact'), { target: { value: ' dpo@codecraft.example ' } });
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: 'Workspace opt-in notice' }));
    });
    expect(calls[0]).toMatchObject({ url: '/api/app/settings/reach-out', body: { workspaceSlug: 'codecraft-web', whatsappOptInNotice: null, privacyContact: 'dpo@codecraft.example' } });
    expect(toast.success).toHaveBeenCalledWith('Opt-in notice and privacy contact saved.');
    expect(refresh).toHaveBeenCalled();
  });
});

const REACH: ReachOutDto = {
  workspace: { slug: 'codecraft-web', name: 'Codecraft Web Studio' },
  noticePrefill: NOTICE,
  noticeIsDefault: true,
  settings: { whatsappOptInNotice: null, privacyContact: null },
  clickToChat: { available: true, displayPhoneNumber: '+919812345678', prefill: 'Hi', link: 'https://wa.me/919812345678?text=Hi', simulated: false },
  permissions: { canRecordOptIn: true, canManageSettings: true },
};
const NONE: ConsentChannelDto = { channel: 'WHATSAPP', state: 'NONE', since: null, source: null };

describe('ReachOutPanel', () => {
  it('shows the WhatsApp state, the opt-in control, the link and the workspace notice', () => {
    const { container } = withCsrf(<ReachOutPanel reachOut={REACH} whatsapp={NONE} leadId="lead_1" handedOver={false} />);
    expect(container.querySelector('[data-reach-out-state="NONE"]')).toBeTruthy();
    expect(screen.getByText('No WhatsApp opt-in')).toBeTruthy();
    expect(container.textContent).toContain('share your click-to-chat link');
    expect(screen.getByRole('button', { name: 'Record WhatsApp opt-in' })).toBeTruthy();
    expect((screen.getByLabelText(/Click-to-chat link to/) as HTMLInputElement).value).toBe('https://wa.me/919812345678?text=Hi');
    expect(container.textContent).toContain('it is not an opt-in for marketing templates');
    expect(container.textContent).toContain('Workspace opt-in notice and privacy contact');
  });

  it('without a WhatsApp number: a configuration gate with the fix link; without the permissions: gates and no notice form', () => {
    const { container } = withCsrf(
      <ReachOutPanel
        reachOut={{ ...REACH, clickToChat: { available: false, reason: 'NO_DISPLAY_NUMBER' }, permissions: { canRecordOptIn: false, canManageSettings: false } }}
        whatsapp={NONE}
        leadId="lead_1"
        handedOver={false}
        integrationsHref="/dashboard/employee/codecraft-web/integrations"
      />,
    );
    const gate = screen.getByRole('button', { name: 'Get click-to-chat link' });
    expect(gate.getAttribute('data-gate-category')).toBe('configuration');
    expect(container.textContent).toContain('Add the display phone number to the WhatsApp integration');
    expect(screen.getByRole('link', { name: 'Open integrations' }).getAttribute('href')).toBe('/dashboard/employee/codecraft-web/integrations');
    expect(screen.getByRole('button', { name: 'Record WhatsApp opt-in' }).getAttribute('data-gate-category')).toBe('permission');
    expect(container.textContent).not.toContain('Workspace opt-in notice and privacy contact');
  });

  it('after the handoff the panel is read-only', () => {
    const { container } = withCsrf(<ReachOutPanel reachOut={REACH} whatsapp={{ ...NONE, state: 'OPT_IN' }} leadId="lead_1" handedOver />);
    expect(screen.getByText('Opt-in on record')).toBeTruthy();
    expect(container.textContent).toContain('This lead was handed over to the client, so reaching out is theirs now.');
    expect(screen.queryByRole('button', { name: 'Record WhatsApp opt-in' })).toBeNull();
    expect(screen.queryByLabelText(/Click-to-chat link to/)).toBeNull();
  });
});
