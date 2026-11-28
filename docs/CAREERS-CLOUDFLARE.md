# MarkChat Careers — Cloudflare / Control Plane Release Runbook

> Status: **DRAFT. DO NOT ENABLE RECRUITMENT OR DEPLOY WITHOUT STAGING VERIFICATION.**
>
> This describes the code currently proposed by Marketing PR #14 and Control Plane PR #1.
> It does **not** claim a local Mac mini, remote D1/R2 account, PostgreSQL instance,
> or a live ClamAV daemon has been configured or tested.

## 1. Authoritative architecture

- Marketing: Astro static site and Cloudflare Worker. The Worker exposes public
  `GET /api/careers/availability`, `GET /api/careers/roles`,
  `GET /api/careers/roles/:slug`, and `POST /api/careers/apply`.
- Control Plane: Fastify/PostgreSQL authoritative recruitment policy, roles,
  application status, and private applicant metadata.
- Private CV objects: Cloudflare R2 through the Control Plane server-only adapter,
  **not** the Marketing Worker, public CMS, or D1 database.
- AV: private network ClamAV `clamd` INSTREAM. CV bytes move from `quarantine/`
  to `clean/` only after the scanner returns the exact-byte clean verdict.
- `MARKCHAT_RATE_DB` (Cloudflare D1) is an *existing rate-limit database*, not a
  Careers application database. Do **not** create a second applicant data store in D1
  without a reviewed architecture change.
- Marketing CMS `markchat_admin_token` and Control Plane `mc_cp_admin` cookie
  are distinct identities. The Marketing dashboard's link to the Control Plane
  settings is navigation, **not** a delegated session. Never forward a browser
  CMS Bearer token to Control Plane's administrator API.

## 2. Local checkout — safe read-only discovery

On the actual Mac mini, inspect each repository before switching branches:

```sh
for repo in "$HOME/Development/markchat-marketing" "$HOME/Development/markchat-control-plane"; do
  test -d "$repo/.git" || { echo "Not a normal git checkout: $repo"; continue; }
  git -C "$repo" status --short
  git -C "$repo" worktree list
  git -C "$repo" fetch origin --prune
done
git -C "$HOME/Development/markchat-marketing" log -5 --oneline origin/fix/careers-fail-closed-applications-20261128
git -C "$HOME/Development/markchat-control-plane" log -5 --oneline origin/feat/careers-recruitment-safe-state-20261128
```

Use separate review worktrees if the primary checkout has uncommitted work.
Never reset, force push, delete, or overwrite unrelated worktrees.

## 3. CI quality gates (execute in the real local checkouts)

Marketing PR #14:

```sh
cd "$HOME/Development/markchat-marketing"
npm ci
npm run check
npm run build
npm test
npx wrangler@4.169.0 deploy --dry-run
git diff --check
```

Control Plane PR #1:

```sh
cd "$HOME/Development/markchat-control-plane"
npm ci
npm run verify:syntax
npm test
npm run test:all
npm run verify:upstream
git diff --check
```

Record exact exit codes. A GitHub Actions `startup_failure` with **no jobs**
may reflect a runner/account-level issue, not passing or failing application tests.
Do not mark CI green until an actual successful run verifies the exact commit.

## 4. PostgreSQL migrations: isolated test database first

The authoritative application schema is in the Control Plane:

- `src/db/migrations/012_careers_recruitment.sql`
- `src/db/migrations/013_careers_private_application_schema.sql`

Use the established test database and **test-only** database users/credentials
already configured for Control Plane. Confirm the database name first.

```sh
cd "$HOME/Development/markchat-control-plane"
# Set NODE_ENV=test, PGDATABASE=<isolated_test_db>, migration credentials via
# a local untracked environment file or the approved secrets mechanism.
npm run migrate
```

Verify `cp_careers_recruitment` exists and starts with `recruitment_open=false`,
`talent_pool_open=false`. Verify `cp_careers_roles` and
`cp_careers_applications` have the expected constraints and permissions.
Do not run against a production database without staging tests and a backup.

## 5. Cloudflare D1 and private R2

The Marketing repository currently has
`sql/markchat-rate-limits.sql` and the Wrangler D1 binding
`MARKCHAT_RATE_DB` / `markchat-rate-db`. It does **not** contain
`sql/markchat-careers.sql`; no Careers D1 migration should be fabricated.

For existing D1 rate-limit tables:

```sh
cd "$HOME/Development/markchat-marketing"
npx wrangler d1 execute markchat-rate-db --local --file=sql/markchat-rate-limits.sql
npx wrangler d1 info markchat-rate-db
```

The Control Plane uses a server-side **R2 S3-compatible API adapter**, not a
Wrangler-bound R2 object. It requires the following secret-only settings:

- `CAREERS_R2_ACCOUNT_ID`
- `CAREERS_R2_PRIVATE_BUCKET`
- `CAREERS_R2_ACCESS_KEY_ID`
- `CAREERS_R2_SECRET_ACCESS_KEY`
- `CAREERS_CLAMD_HOST`
- `CAREERS_CLAMD_PORT`
- `CAREERS_CLAMD_TIMEOUT_MS`

Never put R2 keys into `wrangler.jsonc`, client environment variables,
frontend bundles, test snapshots, or GitHub source.

After authenticated account access is verified:

```sh
cd "$HOME/Development/markchat-marketing"
npx wrangler whoami
npx wrangler r2 bucket list
# Create only when the chosen private bucket is confirmed absent:
# npx wrangler r2 bucket create <approved-private-bucket-name>
```

Verify via actual isolated R2 put/get/delete and `clamd` clean/EICAR
health checks. Do not treat the mere existence of secrets as readiness.

## 6. Known unresolved release blockers

1. Marketing CI failure and Control Plane Actions runner startup failure.
2. Missing Mac mini local execution evidence and staging PostgreSQL migration output.
3. No proven real R2/ClamAV roundtrip; scanner must be unreachable from public internet.
4. Marketing CMS and Control Plane Super Admin use separate credentials. Seamless
   applicant administration via Marketing CMS requires a **reviewed identity bridge**
   or securely delegated session, with server-side verification, expiration, origin,
   authorization and administrator attribution. A generic `admin_ui` actor is not
   individual accountability.
5. PDF keyword checks plus malware scanning are defense in depth but cannot prove
   that arbitrarily compressed/obfuscated active PDF content is absent. Validate an
   established PDF parsing/sanitization strategy before approving arbitrary CVs.
6. Production anti-abuse controls, applicant retention/deletion and notification
   delivery require staging and privacy review.
7. End-to-end synthetic candidate admission, clean scan, private download,
   status change and closed-recruitment denial have not been observed live.

## 7. Exact release order

1. Repair both CI failures and verify every required check on the current PR heads.
2. Validate production-grade identity boundaries, storage, scanner and privacy controls.
3. Apply migrations in isolated staging and test the real environment.
4. Run a full synthetic candidate E2E with
   `tests/fixtures/careers/sample-cv.pdf`.
5. Keep recruitment closed until all prerequisites are confirmed.
6. Merge Control Plane PR #1 after required reviews and checks.
7. Merge compatible Marketing PR #14 after required reviews and checks.
8. Deploy in a controlled backend-first sequence.
9. Verify the deployed commit SHAs, dynamic vacancy URLs and candidate workflow.
10. Synchronize the actual Mac mini worktrees only after confirming they are clean.

**No CI bypass, forced merge, simulated scanner clean verdict, unverified
production claim, or destructive Git operation is acceptable.**
