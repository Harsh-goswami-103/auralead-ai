import type { DocPage } from '../format';

export const security: DocPage = {
  slug: 'security',
  title: 'Security',
  summary:
    'How accounts, sessions and requests are protected: password hashing, lockout, re-authentication, invite and reset links, CSRF, the Content Security Policy, tenant isolation, rate limits, webhook checks, encryption at rest, logging, and the stated limitations.',
  appliesTo: ['DEMO', 'LIVE'],
  checked: '2026-10-20',
  sections: [
    {
      id: 'sign-in',
      title: 'Accounts and sign-in',
      blocks: [
        {
          kind: 'list',
          items: [
            'LIVE accounts sign in with an email address and a password. Passwords are hashed with argon2id (memory 19456 KiB, 2 passes, parallelism 1) and must be 12 to 256 characters long.',
            'Every failed sign-in gets the same answer, "Email or password is incorrect.", and every attempt runs exactly one password verification (against a dummy hash when the email is unknown), so neither the answer nor its timing reveals whether an account exists.',
            '5 failed sign-ins in a row lock the account for 15 minutes. The lock is stored on the account, so a restart does not lift it; while it holds, even the right password fails, and the lock is not extended. After it ends, counting starts again. A password reset also lifts it.',
            'Disabled accounts cannot sign in.',
          ],
        },
        {
          kind: 'list',
          appliesTo: ['DEMO'],
          items: [
            'In DEMO the seeded identities have no password: the persona sign-in (`/api/demo/session`) creates an ordinary DEMO session, and that route answers 404 in LIVE.',
            'A LIVE process never accepts a demo identity or a session created in DEMO.',
            'Switching demo identity replaces the session as a sign-in does.',
          ],
        },
      ],
    },
    {
      id: 'sessions',
      title: 'Sessions',
      blocks: [
        {
          kind: 'list',
          items: [
            'The session cookie `__Host-aura_session` is HttpOnly, Secure, SameSite=Lax and limited to the whole site path. It holds 32 random bytes; the database keeps only their sha256.',
            'A session has an idle timeout of 7 days (renewed while you use it) and an absolute limit of 30 days; super admin sessions end after 12 hours.',
            'Signing in or re-entering your password replaces the session (the old one is revoked). Signing out revokes it on the server.',
            'Changing a person\'s role or account status revokes all of their sessions.',
            '`AUTH_COOKIE_INSECURE_DEV=1` drops the `__Host-` prefix and the Secure flag for a plain-HTTP development host; LIVE logs a warning when it is set.',
          ],
        },
      ],
    },
    {
      id: 're-authentication',
      title: 'Fresh sign-in for sensitive actions',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Pausing or resuming all outbound delivery and every action in the job inspector (cancel, retry, resolving "Delivery unknown") need a password entry or a sign-in within the last 15 minutes. Otherwise the request answers 401 `REAUTH_REQUIRED` and the dialog asks for the password, then retries.',
        },
        {
          kind: 'paragraph',
          appliesTo: ['DEMO'],
          text: 'In DEMO, where personas have no password, the persona sign-in counts.',
        },
      ],
    },
    {
      id: 'invites-and-resets',
      title: 'Invite and reset links',
      blocks: [
        {
          kind: 'list',
          items: [
            'Invite links expire after 72 hours and work once; only the hash of the token is stored. The person chooses their own name and password when they open it. The first administrator\'s invite comes from `npm run admin:bootstrap`.',
            'Reset links expire after 1 hour and work once, and a newer link ends every older unused one. Redeeming a link sets the new password, clears the lockout and revokes every session; it signs nobody in, so a leaked link alone never gives a session. An unknown, used, expired or superseded link gives one identical "not found" answer.',
            'The reset page is `/reset/<token>`. For an administrator, the operator issues the link on the server with `npm run admin:bootstrap -- --recover --email <address>`.',
            'Accepting an invite and redeeming a reset link are each limited to 10 attempts an hour per IP address.',
          ],
        },
      ],
    },
    {
      id: 'csrf',
      title: 'CSRF and origin checks',
      blocks: [
        {
          kind: 'list',
          items: [
            'Changes go only through route handlers under `/api/app/*` and `/api/admin/*`, never through Server Actions, so one CSRF model covers them all.',
            'A request that changes data with the session cookie needs an Origin header equal to `APP_ORIGIN` (the Referer is used only when Origin is missing) and an `X-CSRF-Token` header equal to an HMAC of the session id under `SESSION_SECRET`, which the page receives in a meta tag.',
            'Requests without a session that change state (sign-in, persona switch, invite, reset) still need the right Origin.',
            'Accepting a public quotation needs the share token, a form nonce signed with `SHARE_NONCE_KEY`, the right Origin and the version the page showed.',
            'Webhook routes ignore cookies entirely and authenticate by signature.',
          ],
        },
      ],
    },
    {
      id: 'headers',
      title: 'Content Security Policy and headers',
      blocks: [
        {
          kind: 'list',
          items: [
            'Every page gets a Content Security Policy with a fresh script nonce per request and strict-dynamic: no inline or eval script runs in production. It also sets default-src self, frame-ancestors none, object-src none, base-uri self and form-action self. Styles allow inline attributes, which cannot run script.',
            'With an `https://` `APP_ORIGIN` pages also get Strict-Transport-Security and upgrade-insecure-requests.',
            'Every response carries nosniff, X-Frame-Options DENY, a strict-origin-when-cross-origin Referrer-Policy, a Permissions-Policy that turns off camera, microphone, geolocation and payment, and a same-origin Cross-Origin-Opener-Policy.',
            'The public quotation page sets its own hash-based policy and adds no-referrer, noindex and no-store.',
            'No component injects raw HTML (a lint rule forbids it), inbound email is shown as plain text, and every link that comes from data passes a check that allows only http, https, mailto and tel links, same-origin paths and in-page anchors.',
          ],
        },
      ],
    },
    {
      id: 'tenant-isolation',
      title: 'Tenant isolation',
      blocks: [
        {
          kind: 'list',
          items: [
            'The workspace of a request is decided on the server from the session, the assignment or the job, never from the browser. Every table that holds workspace data carries the workspace id, and the database client adds it to every query.',
            'Ids referenced in a change (a service, quotation, lead or conversation) are checked to belong to the same workspace inside the transaction.',
            'Records of another workspace answer 404. A generated test runs every route for five kinds of caller against another workspace\'s records (`tests/integration/authz/tenant-matrix.test.ts`).',
            'A super admin reaches workspace data only through an elevation that writes its audit event before reading anything.',
          ],
        },
      ],
    },
    {
      id: 'rate-limits',
      title: 'Rate limits',
      blocks: [
        {
          kind: 'table',
          caption: 'Request limits in use',
          head: ['Limit', 'Requests', 'Window', 'Counted per'],
          rows: [
            ['Sign-in by address (`loginIp`)', '5', '1 minute', 'Client IP'],
            ['Sign-in by account (`loginEmail`)', '5', '1 minute', 'Email address; also each password re-entry per user'],
            ['Invites and resets (`inviteReset`)', '10', '1 hour', 'Client IP'],
            ['Public quotation (`publicQuote`)', '30', '1 minute', 'Client IP'],
            ['AI drafts (`aiDraft`)', '30', '1 minute', 'Workspace'],
          ],
        },
        {
          kind: 'paragraph',
          text: 'Over a limit the answer is 429 with Retry-After. The counters live in the web process memory: they are per process and start empty after a restart, which is why a deployment runs one web process. The client IP is the socket address unless `TRUSTED_PROXY_HOPS` says how many proxies to trust in X-Forwarded-For. The account lockout is stored in the database and survives restarts.',
        },
      ],
    },
    {
      id: 'webhooks',
      title: 'Webhook verification',
      blocks: [
        {
          kind: 'list',
          items: [
            'The body is read once as raw bytes, with a size cap, before anything parses it. The WhatsApp webhook checks `X-Hub-Signature-256` over those exact bytes with `META_APP_SECRET`, in constant time, and answers its subscription check only for the right `META_VERIFY_TOKEN` and a well-formed challenge.',
            'A delivery is routed to a workspace by the integration it belongs to, never by trusting the payload; one that matches no integration is stored as unrouted.',
            'Rejected deliveries are counted per day and reason, and their body is never stored.',
            'An accepted delivery is stored twice: a redacted copy for the inspector and the full body encrypted with the key ring for processing, bound to its event id. Duplicates are recognized per provider and source, so the same id from two workspaces never collides.',
          ],
        },
      ],
    },
    {
      id: 'encryption',
      title: 'Encryption at rest',
      blocks: [
        {
          kind: 'list',
          items: [
            'AES-256-GCM with a 12-byte random nonce, under the key ring in `CREDENTIALS_KEYRING`. New data uses the key named by `CREDENTIALS_ACTIVE_KID`; any key in the ring can decrypt, so old data stays readable when a new key is added.',
            'Every ciphertext is bound to where it belongs (its event id, or its workspace, integration and field), so a value copied to another row or tenant fails to decrypt.',
            'Provider API keys are never environment variables: they belong to a workspace\'s integration and are stored encrypted with this key ring.',
            'Webhook processing copies are deleted once they are no longer needed; see [Retention](/docs/data-and-privacy#retention).',
          ],
        },
      ],
    },
    {
      id: 'logging',
      title: 'Logging and redaction',
      blocks: [
        {
          kind: 'list',
          items: [
            'The web app and the worker write JSON log lines to standard output. Every line passes a redaction step: values under secret-like keys (passwords, tokens, cookies, signatures, API keys) and personal keys (phone, email, address, IP) are replaced, and every string is scanned for key and token shapes, email addresses, phone numbers and IPv4 addresses.',
            'Errors are logged as a name and a message, without stack traces. People see a short message and a reference (the request\'s correlation id, also sent as x-request-id), never internals.',
            'Audit events store field names, never personal values; job errors and the webhook inspector view are redacted before they are stored.',
          ],
        },
      ],
    },
    {
      id: 'demo-isolation',
      title: 'DEMO isolation',
      appliesTo: ['DEMO'],
      blocks: [
        {
          kind: 'list',
          items: [
            'A DEMO process makes no outbound request: the outbound guard refuses every host, and every provider is a demo transport.',
            'The demo routes (`/api/demo/*`) and the test-control routes (`/api/test/*`) answer 404 in LIVE; the test routes also need `AURALEAD_TEST_CONTROL=1` and the token in DEMO.',
            'A LIVE build does not contain the role switcher, and the seed refuses a LIVE process or a database that holds LIVE data.',
          ],
        },
      ],
    },
    {
      id: 'limitations',
      title: 'Stated limitations',
      blocks: [
        {
          kind: 'callout',
          tone: 'limit',
          text: 'There is no multi-factor authentication. Strong passwords, the lockout and the short administrator sessions are the protection.',
        },
        {
          kind: 'callout',
          tone: 'limit',
          text: 'There is no self-service "forgot password" email. The platform sends no email of its own (email goes through each workspace\'s integration), so password resets are issued by an operator.',
        },
        {
          kind: 'callout',
          tone: 'limit',
          text: 'Rate limits are kept in one process\'s memory. Running more than one web process would multiply them; a shared store would be needed first.',
        },
        {
          kind: 'paragraph',
          text: 'The full list is on [Limitations](/docs/limitations).',
        },
      ],
    },
  ],
};
