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

  // Import boundaries (also enforced by the graph walk in tests/unit/arch/import-boundaries.test.ts).
  { files: ['src/lib/**/*.{ts,tsx}'], rules: { 'no-restricted-imports': ['error', { patterns: LIB_IMPORTS }] } },
  { files: UI, rules: { 'no-restricted-imports': ['error', { patterns: DB_IMPORTS }] } },
  { files: SERVER_CORE, rules: { 'no-restricted-imports': ['error', { patterns: NEXT_IMPORTS }] } },
  {
    files: ['src/server/adapters/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [...NEXT_IMPORTS, ...SERVICE_IMPORTS] }] },
  },
]);
