'use client';

/**
 * CreateWorkspaceForm (T29): a new workspace in this installation's mode and its first owner. The
 * slug follows the name until edited (lowercase words and single hyphens; checked again on the
 * server, which also refuses reserved and taken slugs). The workspace starts with the production
 * defaults (settings, scoring v1, pipeline v1 with human approval; no services or sample data).
 * The owner gets a single-use invite link shown once here for the administrator to send; an
 * address that already belongs to an active client user becomes the owner directly. Needs a
 * reason and a sign-in within 15 minutes (renewed in place).
 */
import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import { ArrowRight, Building2, CircleCheck, LoaderCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ADMIN_REASON_MAX, ADMIN_REASON_MIN, DEFAULT_WORKSPACE_TIMEZONE, PLAN_LABEL_MAX, WORKSPACE_NAME_MAX, WORKSPACE_SLUG_PATTERN } from '@/lib/schemas/admin-people';
import { OneTimeLink, type OneTimeLinkValue } from './OneTimeLink';
import { ReauthPanel, useAdminPost, type AdminMode } from './use-admin-post';

/** "Asha Physio & Rehab, Pune" -> "asha-physio-rehab-pune" (max 48). */
export function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

const COMMON_TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York'];

type Created = { workspace: { id: string; slug: string; name: string }; owner: { kind: 'invite'; email: string; link: string; expiresAt: string } | { kind: 'membership'; email: string } };

export function CreateWorkspaceForm(props: { mode: AdminMode }) {
  const id = useId();
  const router = useRouter();
  const api = useAdminPost(props.mode);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [planLabel, setPlanLabel] = useState('');
  const [timezone, setTimezone] = useState(DEFAULT_WORKSPACE_TIMEZONE);
  const [ownerEmail, setOwnerEmail] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; reference: string | null } | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [link, setLink] = useState<OneTimeLinkValue | null>(null);
  const shownSlug = slugEdited ? slug : slugFromName(name);
  const slugInvalid = shownSlug.length > 0 && !WORKSPACE_SLUG_PATTERN.test(shownSlug);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) return setError({ message: 'Enter the business name (at least 2 characters).', reference: null });
    if (!WORKSPACE_SLUG_PATTERN.test(shownSlug)) return setError({ message: 'Use 3-48 lowercase letters, digits and single hyphens for the slug.', reference: null });
    if (planLabel.trim().length === 0) return setError({ message: 'Enter a plan label, for example Starter.', reference: null });
    if (reason.trim().length < ADMIN_REASON_MIN) return setError({ message: `Give a reason of at least ${ADMIN_REASON_MIN} characters.`, reference: null });
    setPending(true);
    const result = await api.send<Created>('/api/admin/workspaces', { name, slug: shownSlug, planLabel, timezone, ownerEmail, reason: reason.trim() });
    setPending(false);
    if (!result.ok) {
      setError(result.code === 'REAUTH_REQUIRED' ? { message: 'Confirm your identity below, then create the workspace again.', reference: null } : { message: result.message, reference: result.reference });
      return;
    }
    const data = result.data;
    setCreated(data);
    setLink(data.owner.kind === 'invite' ? { kind: 'invite', link: data.owner.link, expiresAt: data.owner.expiresAt, email: data.owner.email } : null);
    toast.success(`Workspace ${data.workspace.name} created.`);
    setName('');
    setSlug('');
    setSlugEdited(false);
    setPlanLabel('');
    setTimezone(DEFAULT_WORKSPACE_TIMEZONE);
    setOwnerEmail('');
    setReason('');
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {created ? (
        <div role="status" className="flex flex-col gap-2 rounded-xl border border-success/40 bg-success/10 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-fg-1">
            <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success" />
            {created.workspace.name} is ready
          </p>
          <p className="text-sm text-fg-2">
            {created.owner.kind === 'invite'
              ? `It has its settings, scoring and pipeline. ${created.owner.email} becomes its owner by opening the invite link below.`
              : `It has its settings, scoring and pipeline. ${created.owner.email} already had an account and is now its owner; their sessions were ended so the access applies at once.`}
          </p>
          <Link href={`/dashboard/admin/workspaces/${created.workspace.id}`} className="group inline-flex w-fit items-center gap-1 text-sm font-medium text-cyan underline-offset-4 hover:underline">
            Open {created.workspace.name}
            <ArrowRight aria-hidden="true" className="size-3.5 transition-transform duration-fast motion-safe:group-hover:translate-x-0.5" />
          </Link>
        </div>
      ) : null}
      {link ? <OneTimeLink value={link} label="Owner invite link" onDone={() => setLink(null)} /> : null}

      <form noValidate onSubmit={(e) => void submit(e)} className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Business name</Label>
          <Input id={`${id}-name`} maxLength={WORKSPACE_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-slug`}>Slug</Label>
          <Input
            id={`${id}-slug`}
            className="font-mono"
            maxLength={48}
            value={shownSlug}
            aria-invalid={slugInvalid || undefined}
            aria-describedby={`${id}-slug-hint`}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value.toLowerCase());
            }}
          />
          <span id={`${id}-slug-hint`} className={slugInvalid ? 'text-xs text-danger' : 'text-xs text-fg-2'}>
            Used in operator links; 3-48 lowercase letters, digits and single hyphens. It cannot change later.
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-plan`}>Plan label</Label>
          <Input id={`${id}-plan`} maxLength={PLAN_LABEL_MAX} placeholder="Starter" value={planLabel} aria-describedby={`${id}-plan-hint`} onChange={(e) => setPlanLabel(e.target.value)} />
          <span id={`${id}-plan-hint`} className="text-xs text-fg-2">
            A label only; nothing is billed.
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-tz`}>Time zone</Label>
          <Input id={`${id}-tz`} list={`${id}-tz-list`} value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          <datalist id={`${id}-tz-list`}>
            {COMMON_TIMEZONES.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <Label htmlFor={`${id}-owner`}>Owner&apos;s email address</Label>
          <Input id={`${id}-owner`} type="email" autoComplete="off" value={ownerEmail} aria-describedby={`${id}-owner-hint`} onChange={(e) => setOwnerEmail(e.target.value)} />
          <span id={`${id}-owner-hint`} className="text-xs text-fg-2">
            They get a single-use invite link (72 hours) that you send them; an existing client user becomes the owner directly.
          </span>
        </div>
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <Label htmlFor={`${id}-reason`}>Reason (stored on the audit record)</Label>
          <Textarea id={`${id}-reason`} rows={2} maxLength={ADMIN_REASON_MAX} value={reason} aria-describedby={`${id}-reason-help`} onChange={(e) => setReason(e.target.value)} />
          <span id={`${id}-reason-help`} className="text-xs text-fg-2">
            At least {ADMIN_REASON_MIN} characters, for example the signed order or ticket.
          </span>
        </div>
        {api.needsReauth ? (
          <div className="md:col-span-2">
            <ReauthPanel mode={props.mode} reauthing={api.reauthing} error={api.reauthError} onReauth={api.reauthenticate} />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger md:col-span-2">
            {error.message}
            {error.reference ? <span className="block text-xs text-fg-2">Reference: {error.reference}</span> : null}
          </p>
        ) : null}
        <div className="md:col-span-2">
          <Button type="submit" aria-busy={pending || undefined} disabled={pending}>
            {pending ? <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" /> : <Building2 aria-hidden="true" />}
            {pending ? 'Creating...' : 'Create workspace'}
          </Button>
        </div>
      </form>
    </div>
  );
}
