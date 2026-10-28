/**
 * ADR-117: "Record opt-in" on a lead's consent section. It posts the opt-in a person holds evidence
 * for to POST /api/app/consent/grants (channel, purpose, evidence source, the time the opt-in was
 * given, a note) with the CSRF header, and the page re-reads itself afterwards. Only channels the
 * lead has a contact for are offered; the browser checks the evidence time and note before sending
 * and the server answer decides the rest. A lifted or kept opt-out is said in plain words. Without
 * leads.write, or without any contact, the control is gated and says why. Email offers no purpose
 * choice: eligibility counts any email opt-in for every email, so a narrower one would mislead.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordOptIn } from '@/components/leads/RecordOptIn';
import { CsrfProvider } from '@/components/patterns/csrf';
import type { ConsentChannelDto } from '@/lib/schemas/leads';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

afterEach(() => {
  cleanup();
  refresh.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  toast.warning.mockReset();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(response: () => Response) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: init.headers as Record<string, string> });
      return response();
    }),
  );
  return calls;
}

const both: ConsentChannelDto[] = [
  { channel: 'WHATSAPP', state: 'NONE', since: null, source: null },
  { channel: 'EMAIL', state: 'NONE', since: null, source: null },
];
const phoneOnly: ConsentChannelDto[] = [
  { channel: 'WHATSAPP', state: 'NONE', since: null, source: null },
  { channel: 'EMAIL', state: 'NO_CONTACT', since: null, source: null },
];

function renderOptIn(props: Partial<React.ComponentProps<typeof RecordOptIn>> = {}) {
  return render(
    <CsrfProvider token="csrf-consent">
      <RecordOptIn
        leadId="lead_1"
        displayName="Smile Dental"
        consent={phoneOnly}
        phoneE164="+919811100001"
        emailNormalized={null}
        canRecord
        workspaceSlug="smile-avenue-dental"
        {...props}
      />
    </CsrfProvider>,
  );
}

async function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Record opt-in' }));
  return screen.findByRole('dialog');
}

function fill(dialog: HTMLElement, values: { when?: string; note?: string; reference?: string; notice?: string }) {
  if (values.when !== undefined) fireEvent.change(within(dialog).getByLabelText(/When they opted in/), { target: { value: values.when } });
  if (values.note !== undefined) fireEvent.change(within(dialog).getByLabelText('What the evidence is'), { target: { value: values.note } });
  if (values.reference !== undefined) fireEvent.change(within(dialog).getByLabelText('Reference (optional)'), { target: { value: values.reference } });
  if (values.notice !== undefined) fireEvent.change(within(dialog).getByLabelText('Wording they agreed to (optional)'), { target: { value: values.notice } });
}

const submit = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: 'Record opt-in' }));

describe('RecordOptIn', () => {
  it('offers only the channels the lead has a contact for, and says a Maps listing is not an opt-in', async () => {
    renderOptIn();
    const dialog = await openDialog();
    const channel = within(dialog).getByLabelText('Channel');
    expect(within(channel).getAllByRole('option').map((o) => o.textContent)).toEqual(['WhatsApp · +919811100001']);
    expect(dialog.textContent).toContain('A Google Maps listing or a public phone number is not an opt-in.');
    const purpose = within(dialog).getByLabelText('Purpose') as HTMLSelectElement;
    expect(purpose.value).toBe('MARKETING');
    const source = within(dialog).getByLabelText('Evidence') as HTMLSelectElement;
    expect(Array.from(source.options).map((o) => o.value)).toEqual(['MANUAL_EVIDENCE', 'SHEETS_FORM', 'META_FORM']);
  });

  it('posts the opt-in with the CSRF header, then closes and re-reads the page', async () => {
    const calls = stubFetch(() => json({ consentId: 'cons_1', reoptIn: 'NOT_SUPPRESSED' }));
    renderOptIn({ consent: both, emailNormalized: 'owner@smile.test' });
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('Purpose'), { target: { value: 'SERVICE_CONVERSATION' } });
    fireEvent.change(within(dialog).getByLabelText('Channel'), { target: { value: 'EMAIL' } });
    // Eligibility counts any email opt-in for every email, so email offers no narrower purpose.
    expect(within(dialog).queryByLabelText('Purpose')).toBeNull();
    expect(dialog.textContent).toContain('An email opt-in covers every email from this business, marketing included.');
    fireEvent.change(within(dialog).getByLabelText('Evidence'), { target: { value: 'SHEETS_FORM' } });
    fill(dialog, { when: '2026-10-20T10:30', note: '  Signed the enquiry form at the clinic.  ', reference: 'Form #42', notice: 'You may email me offers.' });
    submit(dialog);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/app/consent/grants');
    expect(calls[0]!.headers['x-csrf-token']).toBe('csrf-consent');
    expect(calls[0]!.body).toEqual({
      workspaceSlug: 'smile-avenue-dental',
      leadId: 'lead_1',
      channel: 'EMAIL',
      purpose: 'MARKETING',
      source: 'SHEETS_FORM',
      collectedAt: new Date('2026-10-20T10:30').toISOString(),
      evidence: { note: 'Signed the enquiry form at the clinic.', reference: 'Form #42' },
      noticeText: 'You may email me offers.',
    });
    expect(toast.success).toHaveBeenCalledWith('Opt-in recorded for email.', undefined);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('leaves out the optional fields and the workspace when they are empty (client panel)', async () => {
    const calls = stubFetch(() => json({ consentId: 'cons_2', reoptIn: 'NOT_SUPPRESSED' }));
    renderOptIn({ workspaceSlug: undefined });
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('Purpose'), { target: { value: 'SERVICE_CONVERSATION' } });
    fill(dialog, { when: '2026-10-01T09:00', note: 'Asked us on the phone to message them.' });
    submit(dialog);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({
      leadId: 'lead_1',
      channel: 'WHATSAPP',
      purpose: 'SERVICE_CONVERSATION',
      source: 'MANUAL_EVIDENCE',
      collectedAt: new Date('2026-10-01T09:00').toISOString(),
      evidence: { note: 'Asked us on the phone to message them.' },
    });
    expect(toast.success).toHaveBeenCalledWith('Opt-in recorded for WhatsApp.', undefined);
  });

  it('returns focus to the trigger when the dialog closes', async () => {
    renderOptIn();
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Record opt-in' })));
  });

  it('checks the evidence time and note before sending anything', async () => {
    const calls = stubFetch(() => json({ consentId: 'x', reoptIn: 'NOT_SUPPRESSED' }));
    renderOptIn();
    const dialog = await openDialog();
    fill(dialog, { note: 'Signed form.' });
    submit(dialog);
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Choose when they opted in.');

    fill(dialog, { when: '2999-01-01T00:00' });
    submit(dialog);
    expect((await within(dialog).findByRole('alert')).textContent).toBe('The opt-in time cannot be in the future.');

    fill(dialog, { when: '2026-10-01T09:00', note: 'ok' });
    submit(dialog);
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Describe the evidence in at least 5 characters.');
    expect(calls).toHaveLength(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('shows the server refusal with its reference and keeps the dialog open', async () => {
    stubFetch(() => json({ code: 'NO_CONTACT_FOR_CHANNEL', message: 'This lead has no WhatsApp number.', reference: 'req_9' }, 422));
    renderOptIn();
    const dialog = await openDialog();
    fill(dialog, { when: '2026-10-01T09:00', note: 'Signed form at the desk.' });
    submit(dialog);
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('This lead has no WhatsApp number.');
    expect(alert.textContent).toContain('Reference: req_9');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says when the opt-in lifted an opt-out, and when the opt-out stays', async () => {
    let answer = 'CLEARED';
    stubFetch(() => json({ consentId: 'cons_3', reoptIn: answer }));
    renderOptIn({ consent: [{ channel: 'WHATSAPP', state: 'OPTED_OUT', since: '2026-09-01T00:00:00.000Z', source: 'STOP_KEYWORD' }, phoneOnly[1]!] });
    let dialog = await openDialog();
    fill(dialog, { when: '2026-10-01T09:00', note: 'Sent START again by SMS.' });
    submit(dialog);
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('Opt-in recorded for WhatsApp.', { description: 'Their earlier opt-out is lifted: this opt-in is newer than their last Stop.' });

    answer = 'EVIDENCE_NOT_NEWER';
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    dialog = await openDialog();
    fill(dialog, { when: '2026-08-01T09:00', note: 'Old paper form from August.' });
    submit(dialog);
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(toast.warning).toHaveBeenCalledWith('Opt-in recorded, but the opt-out stays.', {
      description: 'This evidence is older than their latest Stop, so messages on WhatsApp stay blocked.',
    });
  });

  it('is gated without leads.write, and without any contact to record for', () => {
    const { unmount } = renderOptIn({ canRecord: false });
    const gated = screen.getByRole('button', { name: 'Record opt-in' });
    expect(gated.getAttribute('aria-disabled')).toBe('true');
    expect(gated.getAttribute('data-gate-category')).toBe('permission');
    expect(document.body.textContent).toContain('Recording an opt-in needs leads.write');
    fireEvent.click(gated);
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();

    renderOptIn({
      consent: [
        { channel: 'WHATSAPP', state: 'NO_CONTACT', since: null, source: null },
        { channel: 'EMAIL', state: 'NO_CONTACT', since: null, source: null },
      ],
      phoneE164: null,
    });
    const none = screen.getByRole('button', { name: 'Record opt-in' });
    expect(none.getAttribute('data-gate-category')).toBe('eligibility');
    expect(document.body.textContent).toContain('This lead has no phone number or email address to record an opt-in for.');
  });
});
