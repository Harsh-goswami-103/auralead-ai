/**
 * The pipeline editor's two calls (T28): the dry run (`/api/app/pipeline/validate`, 200 with
 * `{ ok, issues }`) and the save (`/api/app/pipeline/versions`, 422 PIPELINE_INVALID carries the
 * issues in `details`). Like `postJson`, it sends the CSRF header and never surfaces a raw body or
 * stack; unlike it, a refusal keeps the server's issue list so it can be drawn on the graph.
 */
import { CSRF_HEADER_NAME } from '@/components/patterns/api-client';
import type { EditorIssue } from './pipeline-model';

export type PipelineCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string | null; message: string; reference: string | null; issues: EditorIssue[] };

const NETWORK = 'The server could not be reached. Check your connection and try again.';

function issuesOf(details: unknown): EditorIssue[] {
  const list = (details as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(list)) return [];
  return list
    .filter((i): i is { code: string; message?: unknown; nodeId?: unknown; edge?: unknown } => typeof i === 'object' && i !== null && typeof (i as { code?: unknown }).code === 'string')
    .map((i) => {
      const edge = i.edge as { from?: unknown; to?: unknown } | undefined;
      return {
        code: i.code,
        message: typeof i.message === 'string' ? i.message : '',
        ...(typeof i.nodeId === 'string' ? { nodeId: i.nodeId } : {}),
        ...(edge && typeof edge.from === 'string' && typeof edge.to === 'string' ? { edge: { from: edge.from, to: edge.to } } : {}),
      };
    });
}

export async function postPipeline<T>(url: string, body: unknown, csrfToken: string | null): Promise<PipelineCallResult<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (csrfToken) headers[CSRF_HEADER_NAME] = csrfToken;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    return { ok: false, status: 0, code: null, message: NETWORK, reference: null, issues: [] };
  }
  const parsed = (await res.json().catch(() => null)) as unknown;
  if (res.ok) return { ok: true, data: parsed as T };
  const err = (parsed ?? {}) as { code?: unknown; message?: unknown; reference?: unknown; details?: unknown };
  return {
    ok: false,
    status: res.status,
    code: typeof err.code === 'string' ? err.code : null,
    message: typeof err.message === 'string' && err.message.length > 0 ? err.message : 'The request failed. Try again.',
    reference: typeof err.reference === 'string' ? err.reference : res.headers.get('x-request-id'),
    issues: issuesOf(err.details),
  };
}

export { issuesOf };
