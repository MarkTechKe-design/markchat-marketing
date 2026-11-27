# Secure MarkChat™ public assistant on Cloudflare Pages

This architecture changes only the `markchat-marketing` repository.
Do not put API credentials in any `PUBLIC_*` variable, browser local storage, or client Astro code.

## Deployment model

The existing Astro project uses `output: static`, so the two authenticated-by-origin
public API handlers are **Cloudflare Pages Functions**, not `src/pages/api/*.ts` Astro
SSR routes. Cloudflare Pages automatically discovers these root-level paths:

- `functions/api/markcopilot.ts` → `GET/POST /api/markcopilot`
- `functions/api/leads.ts` → `POST /api/leads`

Use the Cloudflare Pages build command `npm run build`, output `dist`, and configure
Functions deployment from this repository's root `functions/` directory.
An Astro `npm run preview` process serves the static pages only; it does NOT
execute Cloudflare Pages Functions. Test deployed Functions on a Cloudflare preview
environment or via `npx wrangler pages dev dist`.

## Cloudflare dashboard setup

Under **Workers & Pages → your Pages project → Settings → Variables and Secrets**:

| Server-only binding/secret | Meaning |
| --- | --- |
| `CMS_API_BASE_URL` | HTTPS origin of the deployed authoritative CMS bridge; required for saving leads |
| `CMS_SERVICE_TOKEN` | Optional **server-only** service authorization token, if CMS ingest requires it |
| `CONTROL_PLANE_API_URL` | HTTPS Control Plane origin of the published Core plan catalog (read only) |
| `AI_API_KEY` or `OPENAI_API_KEY` | Server-only bearer credential for OpenAI-compatible chat completions |
| `GEMINI_API_KEY` | Server-only Gemini key, used for native Gemini when no OpenAI key is provided |
| `AI_API_BASE_URL` | Optional HTTPS OpenAI-compatible API origin; never provided by browser |
| `AI_MODEL` | Optional model identifier; default is `gpt-4o-mini` or `gemini-2.5-flash` |
| `RESEND_API_KEY` | Optional server-only Resend API credential |
| `RESEND_FROM_EMAIL` | A sender address verified in Resend, e.g. `notifications@markchat.co.ke` |
| `MARKCHAT_RATE_DB` | Cloudflare D1 database binding (required for both POST endpoints) |

Configure secrets for **Production and Preview** separately, and redeploy after binding
changes. Do not put these bindings in client bundle environment variables, `.env` commits,
or CI build logs. A missing AI credential falls back to the Product Guide. A missing
or failing rate-limit database or CMS persistence returns an explicit error (no false
lead-success message).

## Rate-limit D1 setup

Create a D1 database in Cloudflare, bind it to the Pages project with variable name
`MARKCHAT_RATE_DB`, and run `sql/markchat-rate-limits.sql` against it (via the
Cloudflare D1 console or Wrangler `d1 execute`). The schema uses an atomic UPSERT;
IP values are SHA-256 hashed before storage. This is a per-minute abuse guard:
6 lead attempts and 20 assistant requests per origin IP. Add WAF / Turnstile if
further protection is needed.

## CMS and notification contract

`POST /api/leads` requires:
- Valid same-origin request and JSON content type
- Full name, validated email, Kenyan phone number, business name (optional), interest
- Consent, blank honeypot and elapsed submission time
- Successful D1 rate-limit transaction
- CMS `POST /api/public/leads` response status **200 or 201 with `success: true`**

The server sends the original CMS lead fields (`id`, `fullName`, `email`,
`phone`, `company`, `monthlyVolume`, `source`, `message`) plus additive
`businessName`, `interest`, `transcriptSummary`, `sourcePage`, and
`adminReplyMailto` fields. The underlying CMS server must be verified to accept
and durably retain these fields and make them available to its authorized Admin
Leads dashboard. This repository **cannot verify external CMS persistence** or
modify the external CMS schema without crossing repository boundaries.

After a confirmed save, if Resend is configured, the server sends a notification
to `hello@markchat.co.ke`, `Reply-To` set to the validated client email. Email
failure does not undo a confirmed CMS save. The public response only reports
`notificationSent` and never exposes server secrets.

## Published catalog and fallback

The Product Guide fetches **published CMS features** and the Control Plane plan
catalog server-side at request time. Never use the old hardcoded Widget prices.
When no authoritative catalog is available, the Product Guide **does not quote**
prices and sends visitors to the Pricing page or sales email. AI responses are
plain text, length-capped, reviewed against prohibited terms, and rendered with
`textContent`.

## Verification and rollout gates

```bash
npm ci
npx prettier --write functions/ src/lib/server/ src/components/common/MarkcopilotWidget.astro tests/edge-security.test.mjs
npm run check
npm run build
npm test
```

Test Cloudflare Preview deployments with bindings before merging to main:
1. Without credentials, the assistant reports Product Guide and gives no fabricated price.
2. With AI credentials and a real published catalog, valid questions can use live AI.
3. Cross-origin, bot, oversize, bad email, CRLF and repeated requests are rejected.
4. Force CMS failure: saved confirmation must **not** appear, typed form stays intact.
5. Configure Resend domain and verify the inbox notification and Reply-To action.
6. Verify the persisted lead appears in the authorized Admin Leads backend, with no seeded/demo lead treated as genuine.

**GitHub Actions:** Workflow runs were reported failed before meaningful step logs.
This may be repository/runner entitlement or availability, not source failure.
Review the GitHub Actions run's setup/job eligibility and repository settings before
claiming CI is green. Local passing tests do not prove hosted CI availability.
