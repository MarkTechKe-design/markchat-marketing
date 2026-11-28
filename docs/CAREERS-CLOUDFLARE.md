# Careers: Cloudflare deployment and operations

## Status and deployment model

This upgrade is based on `83cc24d` on `feat/d1-durable-marketing-leads`
([PR #9](https://github.com/MarkTechKe-design/markchat-marketing/pull/9)). This
document prepares preview verification and later production operations; it does
not authorize production promotion or establish that any deployment is live.
**No live Cloudflare, CMS, or Resend service was exercised during implementation.**

Use the Worker configured in [`wrangler.jsonc`](../wrangler.jsonc):
`src/worker.ts` routes the APIs and serves Astro's static `dist` through `ASSETS`.
Astro preview alone does not execute these APIs. Older Pages-only deployment
instructions do not describe this Worker's route dispatch.

## Resource separation

| Binding                   | Production configuration                                    | `previews` configuration                                       |
| ------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| `MARKCHAT_RATE_DB`        | `markchat-rate-db` — `8797f32a-bdd1-4614-aa14-558c28fdd04f` | `markchat-preview-db` — `1989e316-eb00-481f-81e1-7daba3687eb4` |
| `MARKCHAT_CAREERS_BUCKET` | `markchat-careers-cvs`                                      | `markchat-careers-cvs-preview`                                 |
| `ASSETS`                  | Built `dist`                                                | The previewed branch's built `dist`                            |

Confirm the Cloudflare account and resource IDs before operating on them. These
are configured names, not evidence that provisioning has completed. D1 remains
shared with this site's existing rate-limit and lead tables. Do not replace the
database or drop those tables.

This project uses Worker **Previews**, with a `previews` block, not an
`env.preview` environment. Use `wrangler preview`; `wrangler deploy --env preview`
does not select this configuration. Different Previews pointing at these same
preview resources share their data. See [Preview configuration](https://developers.cloudflare.com/workers/previews/configuration/).

## Provision the preview first

The examples use Wrangler `4.169.0`, matching the configuration schema checked
for this work. Run commands from the repository root with the intended account.
Create the bucket only if it does not already exist:

```bash
npx wrangler@4.169.0 r2 bucket create markchat-careers-cvs-preview
npx wrangler@4.169.0 r2 bucket dev-url disable markchat-careers-cvs-preview
npx wrangler@4.169.0 r2 bucket dev-url get markchat-careers-cvs-preview
npx wrangler@4.169.0 r2 bucket domain list markchat-careers-cvs-preview
```

Verify that public `r2.dev` access is disabled and no public custom domain exposes
the bucket. No browser-to-R2 CORS policy or S3 credentials are needed: the Worker
uses its private binding. See [R2 commands](https://developers.cloudflare.com/r2/reference/wrangler-commands/)
and [public bucket controls](https://developers.cloudflare.com/r2/buckets/public-buckets/).

Apply these additive SQL files to the **preview database**:

```bash
npx wrangler@4.169.0 d1 execute markchat-preview-db --remote --file sql/markchat-rate-limits.sql
npx wrangler@4.169.0 d1 execute markchat-preview-db --remote --file sql/markchat-careers.sql
```

**Existing installations:** `CREATE TABLE IF NOT EXISTS` does not add
`scan_status` to an existing table. Inspect `PRAGMA table_info(markchat_career_applications)`
on the intended D1 instance first. If the table already exists without
`scan_status`, apply **only** `sql/markchat-careers-scan-status-migration.sql`
once. Do not run that ALTER migration on a fresh database. The migration defaults
all existing CVs to `pending` so no legacy files become downloadable without
independent verification.

Check the target database reported by Wrangler. If the CLI does not resolve the
preview-only configuration, select the exact preview database and UUID in the
D1 dashboard and execute the files there; do not substitute the production
binding. Existing lead functionality also requires `sql/markchat-leads.sql` from
the base work. These are SQL files, not a configured numbered migration series.

Verify `markchat_rate_limit`, `markchat_career_applications`, and
`markchat_career_hero` exist and inspect their schema. `CREATE TABLE IF NOT EXISTS`
does not repair an incompatible table left by an earlier experiment. The Careers
SQL adds two indexes and restricts consent, CV size, notification flags, and
application statuses. See [D1 execution commands](https://developers.cloudflare.com/d1/wrangler-commands/).

## Configuration and CMS authentication proof

Configure runtime values separately for production and the chosen Preview.
Secrets must not be committed or placed in `PUBLIC_*` variables.

| Setting                 | Actual use                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RATE_HASH_SECRET`      | Required secret, at least 32 characters. HMAC-hashes IPs for the D1 rate guard. Missing/short values make submission unavailable.                    |
| `CAREERS_SCAN_WEBHOOK_SECRET` | Required secret for the scanner callback (at least 32 characters). Configure for the correct Worker or Preview only, never in client code. Without it, scanner promotion fails closed. |
| `CMS_API_BASE_URL`      | Required for live admin verification and authoritative role checks. Use the reachable HTTPS CMS base; no credentials, query, or fragment in the URL. |
| `CMS_SERVICE_TOKEN`     | Existing server-only integration secret, if used elsewhere. It is explicitly rejected as a Careers admin credential.                                 |
| `RESEND_API_KEY`        | Optional notification secret. Omit during ordinary preview testing to avoid real email.                                                              |
| `RESEND_FROM_EMAIL`     | Configured as `leads@markchat.co.ke` in both scopes; it must be a verified Resend sender before notification testing.                                |
| `CAREERS_MEDIA_ORIGIN`  | Optional runtime allowlist origin for an external hero-image host; HTTPS origin only.                                                                |
| `PUBLIC_CMS_MEDIA_HOST` | Build-time public image-origin allowlist. Match `CAREERS_MEDIA_ORIGIN` when using an external media host. This contains an origin, never a secret.   |
| `PUBLIC_BRIDGE_API_URL` | Existing build/browser CMS bridge URL. Set it to the intended catalog and login service; the code's development fallback is `http://localhost:4000`. |

Preview Base secrets initialize new Previews; changing Base secrets does not
update existing Previews. Use the appropriate documented command, for example
`npx wrangler@4.169.0 preview base-config secret put RATE_HASH_SECRET` for the Base,
or `npx wrangler@4.169.0 preview secret put RATE_HASH_SECRET --name careers-upgrade`
for an existing review Preview. Configure other secrets in the same explicit
scope. Preserve the site's existing unrelated AI and lead configuration.

Before collecting real applications, prove the CMS boundary with valid, missing,
expired, and fabricated admin credentials. The Worker accepts the existing
`Authorization: Bearer …` token or `markchat_admin_token` cookie and forwards the
token to:

```text
GET <CMS_API_BASE_URL>/api/admin/cms/applications?limit=1
```

A valid proof must be an HTTP-success `application/json` response containing a
raw array, at most 128 KiB, whose rows have nonempty `id` and `careerId`. An empty
array is allowed. A JSON envelope or HTML login response is not accepted. The
upstream must actually reject invalid tokens with 401/403; an unprotected endpoint
returning `[]` would invalidate the proof. Redirects, timeouts, malformed responses,
and missing configuration fail closed. Test the resulting private Careers routes
with both valid and invalid credentials, without printing tokens or candidate
payloads in logs.

## Build and verify the review Preview

```bash
npm run check
npm run build
npm test
npx wrangler@4.169.0 preview --name careers-upgrade
```

Use the review Preview's actual name if different. [Worker Previews](https://developers.cloudflare.com/workers/previews/get-started/)
can be created without a production deployment. Restrict review access as needed
and use only synthetic candidate data. A successful URL upload does not prove
bindings, authentication, or email work.

Recorded local integration verification used Wrangler `4.169.0`/workerd with
local D1 and R2: the PDF, DOC, and DOCX fixtures each returned 201, exactly three
application rows were stored, and R2 roundtrips were byte-identical at 22,776,
18,432, and 36,801 bytes respectively. An invalid file returned 400; anonymous
application-list and CV requests returned 401. No live provider or Resend was
used. These local results do not replace the deployed-preview checks below.

The final local quality gate passed `npm run check` (221 Astro files, zero errors,
warnings or hints), `npm run build` (168 pages), and `npm test` (272 passed,
zero failures or skips). `wrangler deploy --dry-run` also bundled the Worker and
validated the configured bindings without deploying it. Browser checks covered
mobile/desktop and light/dark forms, status-update failures, private downloads,
and zero observed Careers layout shift during initial load and delayed hero
replacement at 390 and 1440 pixels.

Verify these flows on the deployed Preview:

1. Submit a synthetic PDF, DOC, and DOCX from `tests/fixtures/careers/`; require
   HTTP 201 and verify one D1 row plus its private R2 object. Test empty, oversized,
   invalid, duplicate-field, and cross-origin submissions. The guard allows six
   application attempts per IP per minute; rejection is 429 with `Retry-After`.
2. With a valid CMS session, review, search, paginate, and change status through
   the dashboard. Repeat list/download/status requests with invalid credentials;
   they must never disclose records. Test both existing dashboard mount aliases.
3. Newly uploaded CVs must have `scan_status = pending` and an R2 key beneath
   `quarantine/applications/`. An authenticated recruiter must receive HTTP 423
   when requesting a pending, infected, or failed-scan CV. A separate scanner
   with the configured HMAC secret must inspect those R2 bytes and submit a
   correctly signed verdict; only a confirmed `clean` verdict makes the
   CV downloadable from `clean/applications/`. Verify attachment disposition,
   `private, no-store`, `nosniff`, sandbox CSP, and no public R2 link.
   Test tampered signatures, expired timestamps, SHA mismatches, duplicate
   callbacks, scanner errors, and failed R2/D1 promotion.
4. Save a hero override, reload the public Careers page, and test mobile framing
   and an unavailable image. Verify a failed save reports failure.
5. If deliberately enabling a synthetic notification, verify Resend acceptance,
   delivery separately, Reply-To, and the authenticated dashboard link. **The
   recipient is currently hardcoded to `hello@markchat.co.ke` in preview too.**

## Publishing: hero settings versus roles

The bundled default `public/images/careers-hero.webp` was converted from the
user-supplied `pexels-mikhail-nilov-9301524.jpg` to a 1600 × 1066 WebP. The existing
hero media editor supplies desktop/mobile URLs, alt text and focal positions;
its upload action keeps the existing authenticated CMS media contract.

Careers hero settings are confirmed D1 upserts in `markchat_career_hero` and are
loaded through `/api/careers/hero` at page runtime. A saved override appears on
the next page load without rebuilding. Bundled defaults and a reserved fallback
frame remain available if loading fails. External images require both allowlists
above; changing the build-time allowlist requires rebuilding.

Role editing still uses the existing CMS bridge. Public role lists and
`/careers/[slug]` pages are statically generated, so publishing or closing roles
requires a successful rebuild and deployment to update those pages. Verify the
build actually obtained the intended published catalog: `fetchCareers()` can
fall back to bundled roles when the CMS is unavailable. At submission time,
`CMS_API_BASE_URL` makes the Worker recheck that the requested role is published;
an unavailable configured CMS fails closed. With it unset, a small bundled role
map is used instead. `general` is the separate General Talent Pool route.

## Persistence, ambiguous acknowledgements, and notifications

Submission writes `quarantine/applications/<UUID>/cv.<verified-extension>` to private R2,
then requires D1 `success === true` and exactly one changed row before returning 201. Notification runs afterward. There is no transaction spanning R2, D1,
and Resend; a 503 does not prove that nothing was saved.

On a failed persistence acknowledgement, the handler queries primary D1 by the
generated application ID and exact CV key. If a row is found, or the reconciliation
query fails, it **retains the CV** and returns 503 without sending email. If the
query returns no row, it attempts R2 deletion. Failed cleanup is logged. This
does not provide client retry deduplication: resubmitting can create another UUID.

For an incident, inspect the relevant time window in the private D1/R2 resources.
Match rows and objects by ID and exact `cv_key`; preserve both whenever the write
outcome remains uncertain. For scanner incidents, check both the
`quarantine/applications/` and `clean/applications/` keys before cleanup. After the original operation has settled, verify a
row on primary D1 before deleting an apparent orphan. Check for duplicate
submissions and missing objects. Do not infer safe deletion from one transport
error or one absence observed while a write may still be in flight. No automated
orphan collector or reconciliation queue is implemented. See [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
and [D1 retries](https://developers.cloudflare.com/d1/best-practices/retry-queries/).

`notification_sent = 1` means Resend returned a nonempty email ID and the flag's
D1 update was confirmed; it does **not** mean inbox delivery. A zero means pending
or unconfirmed, including missing configuration, provider failure, or an accepted
email whose flag update failed. Inspect pending rows through restricted D1 access:

```sql
SELECT id, submitted_at
FROM markchat_career_applications
WHERE notification_sent = 0
ORDER BY submitted_at
LIMIT 100;
```

Review the application in the dashboard even if email fails. There is no retry
endpoint, automatic delivery tracking, or webhook fallback for Careers. Before
an operator resend, check provider records to avoid duplicates. Resend uses
`careers-<UUID>` as the idempotency key; identical retries are protected for
24 hours, not indefinitely. See [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).

## File verification and private review

The maximum CV is **5 MiB**; the total multipart request is capped at **5 MiB plus
64 KiB**, counting actual bytes before parsing. Extension and file structure must
agree; MIME claims are not trusted. DOC checking walks bounded compound-file
streams. DOCX checking verifies ZIP records, sizes, CRCs, XML, and relationships,
and rejects encryption, macros, active embedded objects, and archive abuse.

DOCX limits are 256 entries, 8 MiB per expanded part, 20 MiB expanded total,
4 MiB per XML part, and 256 KiB per package-metadata/relationships part. XML is
limited to 64 nesting levels, 64 attributes per element, 8 KiB per tag, and
100,000 tags. Conservative format restrictions can reject unusual valid files.

**A quarantine and scanner-verdict gate is implemented, but no malware scanning
engine or scan queue is included in this PR.** New files are private and
non-downloadable until an external, trusted scanner verifies the exact R2
bytes and reports a signed clean verdict. The structural validator cannot
prove malware absence; PDF token checks do not replace canonical PDF parsing
or deep analysis of compressed object streams, and a DOC/DOCX may still be
malicious. Do not send unsigned, automatic, or assumed-clean verdicts.
Only administrators should read private candidate records, and all downloads
remain attachments. Profile actual preview requests before selecting a Workers
CPU budget; bounded DOCX inspection may exceed the Free request allowance. See
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## Scanner callback, quarantine and promotion

**Scanner deployment is a required operational dependency and is NOT provided
by this repository.** Use an isolated private scanner service with access to
the correct Cloudflare R2 quarantine objects and an actual up-to-date AV engine
(e.g. a maintained ClamAV deployment plus any required document-analysis
policy). Scan the **actual full quarantined file**, not only the filename or
the upload metadata. Scan failures must report `scan_failed`, not `clean`.
Set up a trusted pending-work discovery mechanism (such as a private
queue/worker or an authenticated D1 poller). Neither scheduling nor engine
installation is implemented here; without these, all new CVs remain pending.

**Callback:** `POST /api/careers/cv/<UUID>/scan-result`. This route is for
authenticated internal scanner-to-Worker calls only. It does not accept a
recruiter cookie, applicant credential, or public download token.
Configure `CAREERS_SCAN_WEBHOOK_SECRET` independently for Preview and Production
(minimum 32 characters, random; never commit it). Restrict callback ingress at
the network/Cloudflare layer when feasible. Keep the scanner's R2 credentials
least-privileged and private; never create a public R2 domain for quarantine.

Send exactly these request headers:

```text
Content-Type: application/json
X-MarkChat-Scan-Timestamp: <10-digit Unix epoch seconds>
X-MarkChat-Scan-Signature: sha256=<64 lowercase hex characters>
```

The UTF-8 body must be an exact JSON object with only two fields:

```json
{"status":"clean","sha256":"<64-digit lowercase SHA-256 hex of the R2 file bytes>"}
```

Only `clean`, `infected`, or `scan_failed` are accepted callback verdicts.
The HMAC-SHA256 signature is computed over these **exact bytes** in order:
`timestamp + LF + UUID + LF + rawRequestBody`, where LF is a single byte\n`0x0A` (not the two printable characters `\\` and `n`), with the shared
`CAREERS_SCAN_WEBHOOK_SECRET`. The Worker verifies the signature in constant
time with Web Crypto, rejects timestamps over five minutes old or in the
future by more than five minutes, bounds request bodies to 1 KiB, rejects
extra body fields, and fails closed if configuration is absent.
Do not log the signature, the secret, applicant details, or CV contents.

After authentication, the Worker re-reads the D1 row and quarantined R2
object, bounds the R2 byte stream to 5 MiB, and recalculates SHA-256.
A mismatch results in HTTP 409 with no approval. All transitions are
conditional on `scan_status='pending'` and the original `cv_key`; no
second verdict can overwrite a finalized scan state. For `infected` or
`scan_failed`, the object remains in private quarantine, and downloads
stay blocked.

For `clean`, the Worker first copies the verified bytes to a private
`clean/applications/<UUID>/cv.<extension>` R2 key. Only after that copy
is confirmed does a conditional D1 UPDATE set `scan_status='clean'` and
replace `cv_key`. HTTP 423 denies downloads unless **both** the clean status
and exact released key are present. The original quarantined object is
deleted only after the D1 transition confirms success. If the copy or
database acknowledgement fails, the Worker returns 503 and retains
objects for manual reconciliation; it never approves without a D1
transition. Repeated signed callbacks receive 409.

**The callback authenticates a scanner verdict; it does not establish that
malware scanning happened.** Verify scanner result integrity, engine updates,
supply-chain controls, R2 access separation, a retry/dead-letter process, and
alerts for stuck `pending` and `scan_failed` records before enabling real
customer CV collection.

## Logs, retention, and erasure

Both production and preview observability set `redact_query_string: true`, which
helps keep applicant search terms out of invocation URLs. Confirm this remains
enabled when deploying. Monitor the safe `CAREERS_*` warning codes for insert
acknowledgement, reconciliation, rollback, notification, scanner digest
mismatch, release reconciliation, and hero failures. Do not
add raw forms, tokens, CV bytes, or candidate records to logs.

No retention scheduler or application-deletion API is included. Assign an owner
and a retention period before collecting real applications. For an approved
erasure or retention deletion:

1. Identify the exact application UUID and environment, check applicable holds,
   and read its exact `cv_key` through restricted D1 access.
2. Delete that object from the matching private bucket and confirm completion.
   If deletion fails, keep the row/key for a controlled retry.
3. Delete the D1 row conditionally by UUID and `cv_key`; confirm one row changed
   and that both row and object are absent. Record minimal operational evidence.
4. Address recruiter email copies, downloaded CVs, exports, and applicable backup
   retention. D1 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
   retains history; deleting the current row does not immediately erase recovery
   history. Reapply erasures after a database restore.

Do not enable an R2 expiry rule alone and leave dangling D1 application rows.
Do not delete ambiguous-acknowledgement objects as routine cleanup until reconciled.

## Later production promotion

Production remains a separate release decision after the pending D1 base work
and preview evidence are reviewed. When that promotion is authorized, provision
`markchat-careers-cvs` with the same private-access checks, apply
`sql/markchat-careers.sql` to the confirmed `markchat-rate-db` target, preserve its
existing schemas, and configure production secrets independently. Rebuild from
the intended published CMS catalog and deploy the reviewed Worker and assets.
Verify production authentication, storage, and notification behavior before
collecting real applications; a code deployment alone does not verify those services.
