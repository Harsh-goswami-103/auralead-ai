/**
 * Contract-test transport for the WhatsApp Cloud API adapter (T32): a scripted Graph stand-in that
 * the adapter receives as its `http` seam. It records every request (method, path, query,
 * headers, parsed body) and answers with the documented-shape fixtures in
 * tests/fixtures/whatsapp/documented-shape (derived from Meta's published references, not recorded
 * live traffic; see SOURCES.json there). Nothing leaves the process: an unscripted request fails
 * the test instead of reaching a network.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { OutboundRequest, OutboundResponse } from '@/server/adapters/http/outbound';
import type { GraphHttp } from '@/server/adapters/whatsapp/cloud-api';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../fixtures/whatsapp/documented-shape');

export function waFixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as T;
}

type Sources = { files: Record<string, { httpStatus?: number; kind: string; verified: boolean }> };

export function waFixtureStatus(name: string): number {
  const sources = waFixture<Sources>('SOURCES.json');
  const status = sources.files[name]?.httpStatus;
  if (status === undefined) throw new Error(`no HTTP status recorded for fixture ${name}`);
  return status;
}

export function waFixtureNames(): string[] {
  return Object.keys(waFixture<Sources>('SOURCES.json').files);
}

export type GraphRequest = { method: string; url: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: unknown; raw: Buffer | null };

type Answer = { status: number; body: unknown; headers?: Record<string, string> } | { throw: Error & { code?: string } };
type Route = { method: string; path: RegExp; where?: (req: GraphRequest) => boolean; answers: Answer[] };

/** An error shaped like undici's (a `code` property), for the before/after-write classification. */
export function networkError(code: string, message = code): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

export class FakeGraph {
  readonly requests: GraphRequest[] = [];
  readonly unexpected: GraphRequest[] = [];
  #routes: Route[] = [];

  /** Answers (in order) the next requests matching method and path pattern. */
  on(method: string, pathPattern: RegExp, ...answers: Answer[]): this {
    this.#routes.push({ method, path: pathPattern, answers: [...answers] });
    return this;
  }

  /** Like `on`, for requests that also satisfy `where` (e.g. a `fields` query). */
  onWhere(method: string, pathPattern: RegExp, where: (req: GraphRequest) => boolean, ...answers: Answer[]): this {
    this.#routes.push({ method, path: pathPattern, where, answers: [...answers] });
    return this;
  }

  reset(): void {
    this.#routes = [];
    this.requests.length = 0;
    this.unexpected.length = 0;
  }

  readonly http: GraphHttp = async (url: string, init: OutboundRequest): Promise<OutboundResponse> => {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const raw = init.body === undefined ? null : Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body, 'utf8');
    let body: unknown = null;
    if (raw && (headers['content-type'] ?? '').startsWith('application/json')) body = JSON.parse(raw.toString('utf8'));
    const req: GraphRequest = { method: init.method, url, path: u.pathname, query: Object.fromEntries(u.searchParams.entries()), headers, body, raw };
    this.requests.push(req);
    const route = this.#routes.find((r) => r.method === init.method && r.path.test(u.pathname) && (r.where ? r.where(req) : true) && r.answers.length > 0);
    if (!route) {
      this.unexpected.push(req);
      throw new Error(`unscripted Graph request ${init.method} ${u.pathname}`);
    }
    const answer = route.answers.shift()!;
    if ('throw' in answer) throw answer.throw;
    return { statusCode: answer.status, headers: { 'content-type': 'application/json', ...(answer.headers ?? {}) }, body: typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body) };
  };
}

/** A fixture answer with its documented HTTP status. */
export function fixtureAnswer(name: string, headers?: Record<string, string>): Answer {
  return { status: waFixtureStatus(name), body: waFixture(name), ...(headers ? { headers } : {}) };
}
