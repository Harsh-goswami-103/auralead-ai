'use client';

/**
 * The credential form of an integration's setup page (T32; plan §9 Credentials, ADR-25, ADR-80).
 *
 * - Non-secret settings (phone number ID, model ID, ...) are ordinary fields with their stored
 *   values. Credentials are password fields that always start empty: a saved value is never sent
 *   to the browser, never echoed back after a save and cannot be revealed. A saved credential
 *   shows "Saved •••• 1234" (last four only for long values) and when it was saved; leaving its
 *   field empty keeps it, typing a new value replaces (rotates) it.
 * - The browser runs the same field rules as the server for an immediate answer (aria-invalid plus
 *   the message under the field); the server checks everything again. DEMO accepts `demo_`
 *   placeholders only, so a real secret never lands in a demo database.
 * - After a save the fields are cleared and the page re-reads the masked state. LIVE says the
 *   integration is now "Configured, not verified" until Test connection passes.
 * - Revoke removes every saved credential after a confirmation (and says to revoke the token in
 *   the provider's console too).
 */
import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, CircleCheck, KeyRound, LockKeyhole, Save, ShieldOff } from 'lucide-react';
import { postJson } from '@/components/patterns/api-client';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { useCsrfToken } from '@/components/patterns/csrf';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { IntegrationKind } from '@/lib/domain/enums';
import { formatDateTime } from '@/lib/format/date';
import { checkConfigValue, checkCredentialValue, configRule, credentialRule, DEMO_CREDENTIAL_HINT, REVOKE_CONFIRMATION } from '@/lib/schemas/integrations';

export type CredentialFormConfig = { key: string; label: string; value: string | null };
export type CredentialFormSecret = { field: string; label: string; saved: boolean; last4: string | null; updatedAt: Date | null };

export type CredentialFormProps = {
  workspaceSlug: string;
  workspaceName: string;
  kind: IntegrationKind;
  kindSlug: string;
  label: string;
  provider: string;
  mode: 'demo' | 'live';
  timeZone: string;
  config: CredentialFormConfig[];
  credentials: CredentialFormSecret[];
  /** "Credential unreadable, re-enter" when a saved secret no longer decrypts. */
  credentialProblem: string | null;
};

type SaveResponse = { status: string; simulated: boolean; saved: string[]; replaced: string[]; configChanged: string[] };
type Notice = { tone: 'success' | 'danger'; text: string; reference?: string | null } | null;

function FieldMessage({ id, text }: { id: string; text: string }) {
  return (
    <p id={id} className="flex items-start gap-1 text-xs text-danger">
      <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      {text}
    </p>
  );
}

export function CredentialForm(props: CredentialFormProps) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const formId = useId();
  const [config, setConfig] = useState<Record<string, string>>(() => Object.fromEntries(props.config.map((c) => [c.key, c.value ?? ''])));
  const [secrets, setSecrets] = useState<Record<string, string>>(() => Object.fromEntries(props.credentials.map((c) => [c.field, ''])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState(false);
  const anySaved = props.credentials.some((c) => c.saved);

  function validate(): Record<string, string> {
    const found: Record<string, string> = {};
    for (const c of props.config) {
      const value = (config[c.key] ?? '').trim();
      const original = c.value ?? '';
      if (value === original.trim()) continue;
      if (value === '') {
        if (configRule(props.kind, c.key)?.required) found[`config.${c.key}`] = 'This setting is required.';
        continue;
      }
      const problem = checkConfigValue(props.kind, c.key, value);
      if (problem) found[`config.${c.key}`] = problem;
    }
    for (const c of props.credentials) {
      const raw = secrets[c.field] ?? '';
      const value = props.kind === 'EMAIL_SMTP' && c.field === 'password' ? raw : raw.trim();
      if (value === '') {
        if (!c.saved && credentialRule(props.kind, c.field)?.required) found[`secret.${c.field}`] = 'Required: nothing is saved yet.';
        continue;
      }
      const problem = checkCredentialValue(props.kind, c.field, value, props.mode);
      if (problem) found[`secret.${c.field}`] = problem;
    }
    return found;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setNotice(null);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const changedConfig = Object.fromEntries(props.config.filter((c) => (config[c.key] ?? '').trim() !== (c.value ?? '').trim()).map((c) => [c.key, (config[c.key] ?? '').trim()]));
    const enteredSecrets = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim() !== ''));
    if (Object.keys(changedConfig).length === 0 && Object.keys(enteredSecrets).length === 0) {
      setNotice({ tone: 'danger', text: 'Nothing changed: enter a setting or a credential to save.' });
      return;
    }
    setPending(true);
    try {
      const res = await postJson<SaveResponse>(`/api/app/integrations/${props.kindSlug}/credentials`, { workspaceSlug: props.workspaceSlug, config: changedConfig, credentials: enteredSecrets }, csrf);
      // Whatever the answer, typed secrets leave the browser's state at once.
      setSecrets(Object.fromEntries(props.credentials.map((c) => [c.field, ''])));
      if (!res.ok) {
        setNotice({ tone: 'danger', text: res.message, reference: res.reference });
        return;
      }
      const n = res.data.saved.length;
      const what = n > 0 ? `${n} ${n === 1 ? 'credential' : 'credentials'} encrypted and saved` : 'Settings saved';
      setNotice({
        tone: 'success',
        text: res.data.simulated
          ? `${what} as demo placeholders. Simulated: ${props.provider} is never contacted in DEMO.`
          : `${what}. Status: configured, not verified. Run Test connection to verify with ${props.provider}.`,
      });
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function revoke() {
    const res = await postJson<{ revoked: string[] }>(`/api/app/integrations/${props.kindSlug}/credentials/revoke`, { workspaceSlug: props.workspaceSlug, confirm: REVOKE_CONFIRMATION }, csrf);
    if (!res.ok) return { ok: false as const, message: res.message, reference: res.reference };
    setNotice({ tone: 'success', text: `Saved credentials removed. ${props.label} is now revoked; sends through it stop.` });
    router.refresh();
    return { ok: true as const };
  }

  return (
    <div className="flex flex-col gap-4">
      {props.credentialProblem ? (
        <p role="alert" data-credential-problem className="flex items-start gap-2 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-fg-1">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          <span>
            <span className="font-medium">{props.credentialProblem}.</span> The saved value can no longer be decrypted on this server, so nothing is sent through {props.label}. Enter it again below.
          </span>
        </p>
      ) : null}
      <form id={formId} noValidate onSubmit={onSubmit} aria-label={`${props.label} credentials and settings`} className="flex flex-col gap-4">
        {props.config.length > 0 ? (
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-medium text-fg-1">Settings</legend>
            {props.config.map((c) => {
              const id = `${formId}-config-${c.key}`;
              const rule = configRule(props.kind, c.key);
              const error = errors[`config.${c.key}`];
              return (
                <div key={c.key} className="flex flex-col gap-1.5">
                  <Label htmlFor={id} className="text-fg-1">
                    {c.label}
                    {rule?.required ? <span className="text-xs font-normal text-fg-2">(required)</span> : null}
                  </Label>
                  <Input
                    id={id}
                    name={`config.${c.key}`}
                    value={config[c.key] ?? ''}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setConfig((prev) => ({ ...prev, [c.key]: e.target.value }))}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={[rule ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined}
                    className="font-mono"
                  />
                  {rule ? (
                    <p id={`${id}-hint`} className="text-xs text-fg-2">
                      {rule.hint}
                    </p>
                  ) : null}
                  {error ? <FieldMessage id={`${id}-error`} text={error} /> : null}
                </div>
              );
            })}
          </fieldset>
        ) : null}
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium text-fg-1">Credentials</legend>
          {props.credentials.map((c) => {
            const id = `${formId}-secret-${c.field}`;
            const rule = credentialRule(props.kind, c.field);
            const error = errors[`secret.${c.field}`];
            const describedBy = [`${id}-state`, `${id}-hint`, error ? `${id}-error` : null].filter(Boolean).join(' ');
            const common = {
              id,
              name: `secret.${c.field}`,
              value: secrets[c.field] ?? '',
              autoComplete: 'off',
              spellCheck: false,
              placeholder: c.saved ? 'Leave empty to keep the saved value' : undefined,
              'aria-invalid': error ? true : undefined,
              'aria-describedby': describedBy,
              'data-secret-input': c.field,
            } as const;
            if (rule?.generated) {
              // T34: generated on the server and shown once where it is issued (the Sheets page); never typed in here.
              return (
                <div key={c.field} data-generated-credential={c.field} className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-bg-2/50 px-3 py-2">
                  <p className="flex items-center gap-1.5 text-sm text-fg-1">
                    <KeyRound aria-hidden="true" className="size-4 text-fg-3" />
                    {c.label}
                  </p>
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-fg-2">
                    {c.saved ? (
                      <>
                        <LockKeyhole aria-hidden="true" className="size-3.5 text-success" />
                        <span className="font-mono text-fg-1">{c.last4 ? `Saved •••• ${c.last4}` : 'Saved ••••'}</span>
                        {c.updatedAt ? <span>{`on ${formatDateTime(c.updatedAt, props.timeZone)}`}</span> : null}
                      </>
                    ) : (
                      <span>Not issued</span>
                    )}
                  </p>
                  <p className="text-xs text-fg-2">{rule.hint}</p>
                </div>
              );
            }
            return (
              <div key={c.field} className="flex flex-col gap-1.5">
                <Label htmlFor={id} className="text-fg-1">
                  <KeyRound aria-hidden="true" className="size-4 text-fg-3" />
                  {c.label}
                </Label>
                <p id={`${id}-state`} className="flex flex-wrap items-center gap-1.5 text-xs text-fg-2">
                  {c.saved ? (
                    <>
                      <LockKeyhole aria-hidden="true" className="size-3.5 text-success" />
                      <span className="font-mono text-fg-1">{c.last4 ? `Saved •••• ${c.last4}` : 'Saved ••••'}</span>
                      {c.updatedAt ? <span>{`on ${formatDateTime(c.updatedAt, props.timeZone)}`}</span> : null}
                    </>
                  ) : (
                    <span>Not saved</span>
                  )}
                </p>
                {rule?.multiline ? (
                  <Textarea {...common} rows={4} onChange={(e) => setSecrets((prev) => ({ ...prev, [c.field]: e.target.value }))} className="font-mono text-xs" />
                ) : (
                  <Input {...common} type="password" onChange={(e) => setSecrets((prev) => ({ ...prev, [c.field]: e.target.value }))} className="font-mono" />
                )}
                <p id={`${id}-hint`} className="text-xs text-fg-2">
                  {props.mode === 'demo' ? DEMO_CREDENTIAL_HINT : (rule?.hint ?? '')}
                </p>
                {error ? <FieldMessage id={`${id}-error`} text={error} /> : null}
              </div>
            );
          })}
        </fieldset>
        {notice ? (
          <p
            role={notice.tone === 'danger' ? 'alert' : 'status'}
            data-credential-notice={notice.tone}
            className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-sm text-fg-1', notice.tone === 'danger' ? 'border-danger/35 bg-danger/10' : 'border-success/35 bg-success/10')}
          >
            {notice.tone === 'danger' ? <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" /> : <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />}
            <span>
              {notice.text}
              {notice.reference ? <span className="block text-xs text-fg-2">Reference: {notice.reference}</span> : null}
            </span>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
            <Save aria-hidden="true" />
            {pending ? 'Saving...' : anySaved ? 'Save changes' : 'Save credentials'}
          </Button>
          {anySaved ? (
            <ConfirmDialog
              trigger={
                <Button type="button" variant="outline">
                  <ShieldOff aria-hidden="true" />
                  Revoke credentials
                </Button>
              }
              title={`Revoke ${props.label} credentials?`}
              description={`Every saved credential of ${props.label} is removed from this app and sends through it stop. ${props.provider} is not contacted: revoke the token in the ${props.provider} console as well.`}
              confirmLabel="Revoke credentials"
              pendingLabel="Revoking..."
              workspaceName={props.workspaceName}
              destructive
              onConfirm={revoke}
            />
          ) : null}
        </div>
      </form>
    </div>
  );
}
