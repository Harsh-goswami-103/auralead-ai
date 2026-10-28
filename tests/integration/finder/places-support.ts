/**
 * Contract-test transport for the Google Places adapter (ADR-118, slice F1): the scripted stand-in
 * the WhatsApp contract tests use (`FakeGraph`, method + path pattern, answers in order, an
 * unscripted request fails the test) answering with the documented-shape fixtures in
 * tests/fixtures/places/documented-shape (derived from Google's published references, not recorded
 * live traffic; `verified: false` in SOURCES.json). Nothing leaves the process.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export { FakeGraph, networkError, type GraphRequest } from '../contract/whatsapp-support';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../fixtures/places/documented-shape');

export type PlacesSources = { checked: string; files: Record<string, { httpStatus: number; kind: string; verified: boolean; checked: string; source: string }> };

export function placesFixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as T;
}

export function placesSources(): PlacesSources {
  return placesFixture<PlacesSources>('SOURCES.json');
}

/** A fixture as a scripted answer with its documented HTTP status. */
export function placesAnswer(name: string, headers?: Record<string, string>) {
  const status = placesSources().files[name]?.httpStatus;
  if (status === undefined) throw new Error(`no HTTP status recorded for fixture ${name}`);
  return { status, body: placesFixture(name), ...(headers ? { headers } : {}) };
}

/** The Text Search path and the Place Details path, as the scripted transport matches them. */
export const SEARCH_PATH = /^\/v1\/places:searchText$/;
export const DETAILS_PATH = /^\/v1\/places\/[A-Za-z0-9_-]+$/;

/** A key shaped like a Google API key (fictitious). */
export const PLACES_KEY = 'AIzaSyFinderContractTestKey0000000000000';
