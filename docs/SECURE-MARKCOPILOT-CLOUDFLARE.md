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
| `ADMIN_NOTIFICATION_WEBHOOK_URL` | Optional HTTPS server-side SMTP relay webhook, used when Resend is not configured |
| `ADMIN_NOTIFICATION_WEBHOOK_TOKEN` | Server-only Bearer token authorizing the SMTP relay webhook |
| `MARKCHAT_RATE_DB` | Cloudflare D1 database binding (required for both POST endpoints) |
| `RATE_HASH_SECRET` | Random 32+ character server-only secret for HMAC-hashing IPs before D1 persistence |

Configure secrets for **Production and Preview** separately, and redeploy after binding
changes. Do not put these bindings in client bundle environment variables, `.env` commits,
or CI build logs. A missing AI credential falls back to the Product Guide. A missing
or failing rate-limit database or CMS persistence returns an explicit error (no false
lead-success message).

## Rate-limit D1 setup

Create a D1 database in Cloudflare, bind it to the Pages project with variable name
`MARKCHAT_RATE_DB`, and run `sql/markchat-rate-limits.sql` against it (via the
Cloudflare D1 console or Wrangler `d1 execute`). The schema uses an atomic UPSERT;
IP values are HMAC-SHA256 hashed with the server-only RATE_HASH_SECRET before storage. This is a per-minute abuse guard:
6 lead attempts and 20 assistant requests per origin IP. Add WAF / Turnstile if
further protection is needed.

## D1 lead persistence and notifications

The selected storage mode is Cloudflare D1, using the same existing database binding
`MARKCHAT_RATE_DB` and a separate `markchat_leads` table. Apply
`sql/markchat-leads.sql` once to the same D1 database and confirm the table exists.
D1 must return `success: true` with exactly one changed row from the parameterized
INSERT before the API can acknowledge an inquiry. Email success can never substitute
for database persistence; on an insert failure, the endpoint responds HTTP 502.

A successful insert optionally triggers Resend (or an authenticated mail webhook)
to `hello@markchat.co.ke`. If email succeeds, the record's
`notification_sent` value is set to 1. A notification failure does not erase
the already-saved lead, and the response reports `notificationSent: false`.

**The existing Admin Leads UI still contains demo seed rows and does not
automatically read D1.** Until a securely authenticated, read-only Admin Leads
API is implemented, admins need restricted D1 operator access and notification
emails. Never create a public GET /api/leads endpoint.

Customer names, email addresses and telephone numbers are personal data. Review
data retention, access policy, backups, geography (the existing database is in
WEUR), and privacy notices before collecting production inquiries.

`CMS_API_BASE_URL` is no longer needed for the lead POST path with D1
authoritative storage. It can still be used by the published feature catalog;
`CONTROL_PLANE_API_URL` can supply published pricing.

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
