/**
 * T38 / plan §9 Supply chain: no provider key shape and no secret environment variable name in
 * anything shipped to a browser. Scans `<dist>/static/**` (the client bundles) of the DEMO and the
 * LIVE build produced by the E2E global setup, and the HTML of the public pages. Provider SDKs and
 * secrets stay on the server; the browser only ever sees masked values.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const repoRoot = () => process.env.E2E_REPO_ROOT ?? process.cwd();

/** Shapes of real provider credentials, anchored so ordinary minified code cannot match. */
const KEY_SHAPES: Array<[string, RegExp]> = [
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{10,}/],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['Resend key', /\bre_[A-Za-z0-9]{20,}/],
  ['Meta access token', /\bEAA[A-Za-z0-9]{30,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['extension token', /\balx_[0-9a-f]{16}_[A-Za-z0-9_-]{43}/],
];

/** Server-only configuration names (NEXT_PUBLIC_APP_MODE is public by design and not listed). */
const SECRET_ENV_NAMES = [
  'SESSION_SECRET',
  'SHARE_NONCE_KEY',
  'SUPPRESSION_PEPPER',
  'CREDENTIALS_KEYRING',
  'CREDENTIALS_ACTIVE_KID',
  'META_APP_SECRET',
  'META_VERIFY_TOKEN',
  'TEST_CONTROL_TOKEN',
];

function files(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full, accept));
    else if (accept(name)) out.push(full);
  }
  return out;
}

for (const [mode, dist] of [
  ['DEMO', '.next'],
  ['LIVE', '.next-live'],
] as const) {
  test(`the ${mode} client bundles contain no provider key and no secret variable name`, () => {
    const staticDir = path.join(repoRoot(), dist, 'static');
    const bundles = files(staticDir, (n) => /\.(js|css|map|json|txt|html)$/.test(n) && !n.endsWith('.map'));
    expect(bundles.length, `${staticDir} has client files`).toBeGreaterThan(20);
    const hits: string[] = [];
    for (const file of bundles) {
      const text = readFileSync(file, 'utf8');
      for (const [label, shape] of KEY_SHAPES) if (shape.test(text)) hits.push(`${path.relative(repoRoot(), file)}: ${label}`);
      for (const name of SECRET_ENV_NAMES) if (new RegExp(`\\b${name}\\b`).test(text)) hits.push(`${path.relative(repoRoot(), file)}: ${name}`);
    }
    expect(hits).toEqual([]);
  });
}

test('public pages carry no key shape or secret variable name', async ({ request }) => {
  for (const url of ['/', '/login']) {
    const text = await (await request.get(url)).text();
    for (const [label, shape] of KEY_SHAPES) expect(shape.test(text), `${url}: ${label}`).toBe(false);
    for (const name of SECRET_ENV_NAMES) expect(text.includes(name), `${url}: ${name}`).toBe(false);
  }
});
