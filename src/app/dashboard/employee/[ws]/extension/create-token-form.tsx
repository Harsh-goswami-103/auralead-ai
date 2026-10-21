'use client';

/**
 * Create an ingestion token (T36; plan §9 Extension: "shown once"). The form posts the name, the
 * optional allowed Chrome extension id and an optional expiry. On success the token is shown once
 * in a read-only field with Copy and the instruction to paste it into the bridge's options page;
 * "Done" removes it from the page's memory and re-reads the list, where only the prefix remains.
 * The token is never written to browser storage. Without `extension.manage` the page renders a
 * permission-gated control instead of this form.
 */
import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, KeyRound, Plus, ShieldCheck } from 'lucide-react';
import { CopyButton } from '@/components/admin/CopyButton';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { CHROME_EXTENSION_ID_RE } from '@/lib/schemas/webhooks';

type Created = { token: string; prefix: string; name: string };

export function CreateTokenForm(props: { workspaceSlug: string; limitReached: boolean; limit: number }) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const id = useId();
  const [name, setName] = useState('');
  const [extensionId, setExtensionId] = useState('');
  const [expiry, setExpiry] = useState('');
  const [error, setError] = useState<{ message: string; reference: string | null } | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setFieldError(null);
    const trimmedId = extensionId.trim();
    if (name.trim() === '') {
      setFieldError('Name the token, for example after the laptop it is used on.');
      return;
    }
    if (trimmedId !== '' && !CHROME_EXTENSION_ID_RE.test(trimmedId)) {
      setFieldError('A Chrome extension id is 32 letters from a to p (see chrome://extensions or the bridge options page).');
      return;
    }
    setPending(true);
    try {
      const res = await postJson<Created>(
        '/api/app/extension/tokens',
        { workspaceSlug: props.workspaceSlug, name: name.trim(), allowedExtensionId: trimmedId === '' ? null : trimmedId, expiresInDays: expiry === '' ? null : Number(expiry) },
        csrf,
      );
      if (!res.ok) {
        setError({ message: res.message, reference: res.reference });
        return;
      }
      setCreated({ token: res.data.token, prefix: res.data.prefix, name: res.data.name });
      setName('');
      setExtensionId('');
      setExpiry('');
    } finally {
      setPending(false);
    }
  }

  function done() {
    setCreated(null);
    router.refresh();
  }

  if (created) {
    return (
      <div data-token-reveal className="flex flex-col gap-3 rounded-lg border border-success/35 bg-success/8 p-4">
        <p className="flex items-start gap-2 text-sm text-fg-1">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
          <span>
            Token <span className="font-medium">{created.name}</span> created. Copy it now and paste it into the bridge&apos;s options page: it is shown only this once. Afterwards only its prefix{' '}
            <span className="font-mono">{created.prefix}</span> is known.
          </span>
        </p>
        <div className="flex items-center gap-2">
          <Label htmlFor={`${id}-token`} className="sr-only">
            New ingestion token
          </Label>
          <Input id={`${id}-token`} readOnly value={created.token} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <CopyButton value={created.token} label="ingestion token" showText />
        </div>
        <div>
          <Button type="button" variant="outline" onClick={done}>
            Done, I copied it
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form noValidate onSubmit={submit} aria-label="Create an ingestion token" className="flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>
            <KeyRound aria-hidden="true" className="size-4 text-fg-3" />
            Name
          </Label>
          <Input id={`${id}-name`} value={name} maxLength={80} autoComplete="off" placeholder="Front desk laptop" onChange={(e) => setName(e.target.value)} aria-invalid={fieldError && name.trim() === '' ? true : undefined} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-ext`}>Allowed extension id (optional)</Label>
          <Input id={`${id}-ext`} value={extensionId} autoComplete="off" spellCheck={false} className="font-mono text-xs" placeholder="32 letters a-p" onChange={(e) => setExtensionId(e.target.value)} aria-describedby={`${id}-ext-hint`} />
          <p id={`${id}-ext-hint`} className="text-xs text-fg-2">
            Shown in the bridge&apos;s options page. Only this extension may then use the token.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-expiry`}>Expires</Label>
          <NativeSelect id={`${id}-expiry`} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            <option value="">Never (revoke when no longer used)</option>
            <option value="30">After 30 days</option>
            <option value="90">After 90 days</option>
            <option value="365">After 365 days</option>
          </NativeSelect>
        </div>
      </div>
      {fieldError ? (
        <p role="alert" className="flex items-start gap-1 text-xs text-danger">
          <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          {fieldError}
        </p>
      ) : null}
      {error ? (
        <p role="alert" data-create-error className="flex items-start gap-2 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-fg-1">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          <span>
            {error.message}
            {error.reference ? <span className="block text-xs text-fg-2">Reference: {error.reference}</span> : null}
          </span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
          <Plus aria-hidden="true" />
          {pending ? 'Creating...' : 'Create token'}
        </Button>
        {props.limitReached ? <span className="text-xs text-fg-2">This workspace has {props.limit} active tokens, the most allowed. Revoke one first.</span> : null}
      </div>
    </form>
  );
}
