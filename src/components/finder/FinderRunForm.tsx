'use client';

/**
 * The Lead Finder's search form (ADR-118, slice F1): keywords and locations one per line (at most
 * 10 each, every keyword is searched in every location), results per search (20, 40 or 60: one to
 * three Text Search pages), opt-in website email extraction with a blacklist of addresses or
 * domains never to keep. "Start search" posts once per click (a fresh request key; the button is
 * busy while the request runs) and selects the new run. Without `finder.run`, or in LIVE without a
 * Google Places key, the button stays focusable and says why (GatedAction: permission,
 * configuration).
 */
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { Search } from 'lucide-react';
import { toast } from 'sonner';
import { newRequestKey } from '@/components/inbox/api';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { FINDER_LIMITS } from '@/server/services/lead-finder/schemas';
import { finderHref } from './finder-vocabulary';

function lines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const v = raw.trim().replace(/\s+/g, ' ');
    if (v === '' || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

export function FinderRunForm(props: { workspaceSlug: string; mode: 'demo' | 'live'; gate: Gate | null }) {
  const router = useRouter();
  const csrfToken = useCsrfToken();
  const ids = { keywords: useId(), locations: useId(), perQuery: useId(), emails: useId(), blacklist: useId(), help: useId(), error: useId() };
  const [keywords, setKeywords] = useState('');
  const [locations, setLocations] = useState('');
  const [maxPerQuery, setMaxPerQuery] = useState<20 | 40 | 60>(20);
  const [extractEmails, setExtractEmails] = useState(false);
  const [blacklist, setBlacklist] = useState('');
  const [error, setError] = useState<string | null>(null);

  const kw = lines(keywords);
  const loc = lines(locations);
  const searches = kw.length * loc.length;
  const pages = maxPerQuery / 20;

  async function start() {
    if (kw.length === 0 || loc.length === 0) return setError('Add at least one keyword and one location.');
    if (kw.length > FINDER_LIMITS.maxKeywords || loc.length > FINDER_LIMITS.maxLocations) return setError(`Use at most ${FINDER_LIMITS.maxKeywords} keywords and ${FINDER_LIMITS.maxLocations} locations.`);
    setError(null);
    const res = await postJson<{ run: { id: string }; created: boolean }>(
      '/api/app/finder/runs',
      { workspaceSlug: props.workspaceSlug, requestKey: newRequestKey(), keywords: kw, locations: loc, maxPerQuery, extractEmails, emailBlacklist: extractEmails ? lines(blacklist) : [] },
      csrfToken,
    );
    if (!res.ok) {
      setError(res.message);
      toast.error(res.message, { description: res.reference ? `Reference: ${res.reference}` : undefined });
      return;
    }
    toast.success(res.data.created ? 'Search started.' : 'This search is already in the list.', { description: 'Results appear below as each search finishes.' });
    router.push(finderHref(props.workspaceSlug, { run: res.data.run.id }));
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.keywords} className="text-sm font-medium text-fg-1">
            Keywords, one per line
          </label>
          <Textarea id={ids.keywords} value={keywords} onChange={(e) => setKeywords(e.target.value)} rows={4} placeholder={'restaurants\ndental clinic'} aria-describedby={ids.help} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.locations} className="text-sm font-medium text-fg-1">
            Locations, one per line
          </label>
          <Textarea id={ids.locations} value={locations} onChange={(e) => setLocations(e.target.value)} rows={4} placeholder={'Indore\nBhopal'} aria-describedby={ids.help} />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.perQuery} className="text-sm font-medium text-fg-1">
            Results per search
          </label>
          <NativeSelect id={ids.perQuery} value={String(maxPerQuery)} onChange={(e) => setMaxPerQuery(Number(e.target.value) as 20 | 40 | 60)} wrapperClassName="w-40">
            {FINDER_LIMITS.perQueryOptions.map((n) => (
              <option key={n} value={n}>
                Up to {n}
              </option>
            ))}
          </NativeSelect>
        </div>
        <label htmlFor={ids.emails} className="flex min-h-9 items-center gap-2 text-sm text-fg-1">
          <input id={ids.emails} type="checkbox" checked={extractEmails} onChange={(e) => setExtractEmails(e.target.checked)} className="size-4 accent-cyan" />
          Look for email addresses on each listed website
        </label>
      </div>
      {extractEmails ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.blacklist} className="text-sm font-medium text-fg-1">
            Never keep these addresses or domains, one per line
          </label>
          <Textarea id={ids.blacklist} value={blacklist} onChange={(e) => setBlacklist(e.target.value)} rows={2} placeholder={'gmail.com\nnoreply@example.in'} />
          <p className="text-xs text-fg-2">
            {props.mode === 'live'
              ? 'Reads the home page and up to two contact pages of each listed website, honours robots.txt and keeps only addresses published there.'
              : 'DEMO finds simulated @demo-leads.in addresses; no website is contacted.'}
          </p>
        </div>
      ) : null}
      <p id={ids.help} className="text-xs text-fg-2">
        {searches === 0
          ? `Every keyword is searched in every location: at most ${FINDER_LIMITS.maxKeywords} keywords and ${FINDER_LIMITS.maxLocations} locations.`
          : `${searches} ${searches === 1 ? 'search' : 'searches'} (${kw.length} × ${loc.length}), up to ${(searches * maxPerQuery).toLocaleString('en-IN')} results.`}
        {props.mode === 'live' && searches > 0 ? ` Uses up to ${searches * pages} paid Google Places requests on your key.` : ''}
      </p>
      {error ? (
        <p id={ids.error} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div>
        <GatedAction label="Start search" pendingLabel="Starting..." icon={<Search aria-hidden="true" />} gate={props.gate} onAction={start} />
      </div>
    </div>
  );
}
