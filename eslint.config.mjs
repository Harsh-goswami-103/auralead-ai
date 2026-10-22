// Flat config (ESLint 10). Architectural rules from plan §3 "Import rules" and §12 (GatedAction),
// verified by tests/unit/arch/lint-rules.test.ts. ESLint replaces (not merges) a rule's options
// when several blocks match a file, so each restricted rule is defined once per disjoint area.
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// ---- no-restricted-syntax selectors ---------------------------------------------------------
const CLOCK = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'Use the injected clock (ctx.clock / src/lib/clock.ts) instead of Date.now().',
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'Use the injected clock (ctx.clock / src/lib/clock.ts) instead of argument-less new Date().',
  },
];

const NO_DANGEROUS_HTML = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'dangerouslySetInnerHTML is banned: render text, or sanitize through a reviewed component.',
  },
];

const EMPTY_HANDLER = [
  {
    selector:
      "JSXAttribute[name.name=/^on[A-Z]/] > JSXExpressionContainer > :matches(ArrowFunctionExpression, FunctionExpression)[body.type='BlockStatement'][body.body.length=0]",
    message: 'Empty event handler: every control must do real work or be a GatedAction with a reason (plan §12).',
  },
];

const GLOW_RE = String.raw`/shadow-\[0_0_|drop-shadow/`;
const GLOW = [
  {
    selector: `Literal[value=${GLOW_RE}]`,
    message: 'Glow utilities (shadow-[0_0_*], drop-shadow) belong only in src/components/visual/**.',
  },
  {
    selector: `TemplateElement[value.raw=${GLOW_RE}]`,
    message: 'Glow utilities (shadow-[0_0_*], drop-shadow) belong only in src/components/visual/**.',
  },
];

// The violet --ai token (Tailwind color 'ai') is reserved for AI provenance and AI mode (plan §3, §10):
// only AI components (src/components/ai/**) may use it. No '/' inside the regex (esquery syntax), so
// opacity suffixes (bg-ai/20) are matched by the trailing lookahead instead.
const AI_TOKEN_RE = String.raw`/(?:^|[\s:!])(?:text|bg|border|border-[trblxyse]|ring|ring-offset|outline|fill|stroke|from|via|to|decoration|shadow|accent|caret|divide|placeholder)-ai(?![\w-])|--(?:color-)?ai(?![\w-])/`;
const AI_TOKEN_MESSAGE = 'The --ai color token is reserved for AI provenance and AI mode: use it only in src/components/ai/** (plan §3, §10).';
const AI_TOKEN = [
  { selector: `Literal[value=${AI_TOKEN_RE}]`, message: AI_TOKEN_MESSAGE },
  { selector: `TemplateElement[value.raw=${AI_TOKEN_RE}]`, message: AI_TOKEN_MESSAGE },
];

const COMING_SOON_RE = '/coming\\s+soon/i';
const COMING_SOON = [
  { selector: `Literal[value=${COMING_SOON_RE}]`, message: '"Coming soon" copy is banned (plan §12): build it or omit it.' },
  { selector: `JSXText[value=${COMING_SOON_RE}]`, message: '"Coming soon" copy is banned (plan §12): build it or omit it.' },
  { selector: `TemplateElement[value.raw=${COMING_SOON_RE}]`, message: '"Coming soon" copy is banned (plan §12): build it or omit it.' },
];

// ---- no-restricted-imports groups -----------------------------------------------------------
const NEXT_IMPORTS = [
  { group: ['next', 'next/*'], message: 'Core server code must not import Next.js (the worker would crash).' },
  { group: ['server-only'], message: 'Core server code must not import server-only (the worker would crash).' },
];
const DB_IMPORTS = [
  {
    group: ['@/generated/prisma', '@/generated/prisma/*', '@/server/db', '@/server/db/*', '@prisma/client', '@prisma/client/*'],
    message: 'The DB layer is importable only from src/server/**, worker/**, prisma/seed/**, scripts/** and tests/**.',
  },
];
const LIB_IMPORTS = [
  { group: ['next', 'next/*', 'server-only'], message: 'src/lib is framework-free.' },
  { group: ['@prisma/*', '@/generated/*', '@/server/*', '@/app/*', '@/components/*'], message: 'src/lib imports nothing from server, app, components or Prisma.' },
  { regex: String.raw`^(\.\./)+(server|app|generated|components)(/|$)`, message: 'src/lib imports nothing from server, app, components or Prisma.' },
];
const SERVICE_IMPORTS = [
  { group: ['@/server/services', '@/server/services/*'], message: 'Adapters never import services.' },
  { regex: String.raw`^(\.\./)+services(/|$)`, message: 'Adapters never import services.' },
];

// ---- auralead/no-adapter-in-tx (plan §3, T19) ------------------------------------------------
// Inside a transaction callback (withTx, fencedTx, $transaction, the suppression tx helpers) no
// symbol imported from an `adapters/` module may be used and no network call may be made: a
// provider call there would hold the SQLite write lock across the network and break the outbox
// order (plan §4.4). Type-only imports are fine.
const TX_CALLEES = new Set(['withTx', 'fencedTx', '$transaction', 'runSuppressionTx', 'withSuppressionTx', 'scopedFencedTx']);
const NETWORK_MODULES = /^(?:undici|node:https?|https?|node:net|net|node:tls|tls|node:dgram|dgram)$/;
const NETWORK_GLOBALS = new Set(['fetch']);
const NETWORK_IMPORTS = new Set(['safeFetch']);

function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return callee.property.name;
  return null;
}

function visit(node, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) visit(child, fn);
    else if (value && typeof value.type === 'string') visit(value, fn);
  }
}

const noAdapterInTx = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      adapter: "'{{name}}' comes from an adapter module: provider calls never run inside a transaction callback (plan §3, §4.4).",
      network: "'{{name}}' is a network call: never inside a transaction callback (plan §3, §4.4).",
    },
  },
  create(context) {
    const adapterNames = new Set();
    const networkNames = new Set();
    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type') return;
        const source = String(node.source.value);
        const isAdapter = /(?:^|\/)adapters\//.test(source);
        const isNetwork = NETWORK_MODULES.test(source);
        for (const spec of node.specifiers) {
          if (spec.importKind === 'type') continue;
          if (isAdapter) adapterNames.add(spec.local.name);
          if (isNetwork || NETWORK_IMPORTS.has(spec.local.name)) networkNames.add(spec.local.name);
        }
      },
      CallExpression(node) {
        if (!TX_CALLEES.has(calleeName(node.callee))) return;
        for (const arg of node.arguments) {
          if (arg.type !== 'ArrowFunctionExpression' && arg.type !== 'FunctionExpression') continue;
          visit(arg.body, (inner) => {
            if (inner.type === 'Identifier' && adapterNames.has(inner.name)) {
              const parent = inner.parent;
              const isKey = parent && parent.type === 'Property' && parent.key === inner && !parent.computed;
              const isMember = parent && parent.type === 'MemberExpression' && parent.property === inner && !parent.computed;
              if (!isKey && !isMember) context.report({ node: inner, messageId: 'adapter', data: { name: inner.name } });
            }
            if (inner.type === 'CallExpression' && inner.callee.type === 'Identifier') {
              const name = inner.callee.name;
              if (networkNames.has(name) || (NETWORK_GLOBALS.has(name) && !adapterNames.has(name))) {
                context.report({ node: inner, messageId: 'network', data: { name } });
              }
            }
          });
        }
      },
    };
  },
};

const AURALEAD_PLUGIN = { rules: { 'no-adapter-in-tx': noAdapterInTx } };

const SERVER_CORE = ['src/server/{services,adapters,jobs,security,pdf}/**/*.{ts,tsx}'];
const UI = ['src/app/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'];
const VISUAL = ['src/components/visual/**/*.{ts,tsx}'];
const AI_UI = ['src/components/ai/**/*.{ts,tsx}'];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    '.next/**',
    '.next-live/**',
    'out/**',
    'build/**',
    'dist/**',
    'coverage/**',
    'test-results/**',
    'playwright-report/**',
    'next-env.d.ts',
    'src/generated/**',
    // Agent worktrees and local tooling state; never part of the project.
    '.claude/**',
  ]),

  {
    rules: {
      // App Router only: there is no pages/ directory for this rule to inspect.
      '@next/next/no-html-link-for-pages': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // Typed rules: no floating promises in app, server, worker and scripts (plan §4.3).
  {
    files: ['src/**/*.{ts,tsx}', 'worker/**/*.ts', 'scripts/**/*.ts', 'prisma/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: { '@typescript-eslint/no-floating-promises': 'error' },
  },

  // Server and worker: no adapter symbols or network calls inside transaction callbacks (T19).
  {
    files: ['src/server/**/*.{ts,tsx}', 'worker/**/*.ts'],
    plugins: { auralead: AURALEAD_PLUGIN },
    rules: { 'auralead/no-adapter-in-tx': 'error' },
  },

  // Server and worker: injected clock only.
  {
    files: ['src/server/**/*.{ts,tsx}', 'worker/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...CLOCK, ...NO_DANGEROUS_HTML] },
  },

  // UI: no empty handlers, no raw HTML, no glow outside visual, no --ai outside AI components,
  // no TODO / coming soon.
  {
    files: UI,
    ignores: [...VISUAL, ...AI_UI],
    rules: { 'no-restricted-syntax': ['error', ...EMPTY_HANDLER, ...NO_DANGEROUS_HTML, ...GLOW, ...AI_TOKEN, ...COMING_SOON] },
  },
  {
    files: VISUAL,
    rules: { 'no-restricted-syntax': ['error', ...EMPTY_HANDLER, ...NO_DANGEROUS_HTML, ...AI_TOKEN, ...COMING_SOON] },
  },
  {
    files: AI_UI,
    rules: { 'no-restricted-syntax': ['error', ...EMPTY_HANDLER, ...NO_DANGEROUS_HTML, ...GLOW, ...COMING_SOON] },
  },
  {
    files: UI,
    rules: { 'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx'], location: 'anywhere' }] },
  },

  // extension-bridge/ (T36, ADR-110): plain browser JavaScript that runs inside a Chrome MV3
  // extension, not in the app. saas-sync.js is a classic script (importScripts in the vendor's
  // service worker), options.js an ES module of the options page. Globals are listed here
  // explicitly (no extra dependency); undefined names are errors.
  {
    files: ['extension-bridge/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: {
        chrome: 'readonly',
        globalThis: 'readonly',
        console: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        TextEncoder: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        ServiceWorkerGlobalScope: 'readonly',
        importScripts: 'readonly',
      },
    },
    rules: { 'no-undef': 'error', 'no-restricted-globals': ['error', 'localStorage', 'sessionStorage', 'eval'] },
  },
  { files: ['extension-bridge/saas-sync.js'], languageOptions: { sourceType: 'script' } },
  { files: ['extension-bridge/options.js'], languageOptions: { sourceType: 'module' } },

  // Import boundaries (also enforced by the graph walk in tests/unit/arch/import-boundaries.test.ts).
  { files: ['src/lib/**/*.{ts,tsx}'], rules: { 'no-restricted-imports': ['error', { patterns: LIB_IMPORTS }] } },
  { files: UI, rules: { 'no-restricted-imports': ['error', { patterns: DB_IMPORTS }] } },
  { files: SERVER_CORE, rules: { 'no-restricted-imports': ['error', { patterns: NEXT_IMPORTS }] } },
  {
    files: ['src/server/adapters/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [...NEXT_IMPORTS, ...SERVICE_IMPORTS] }] },
  },
]);
