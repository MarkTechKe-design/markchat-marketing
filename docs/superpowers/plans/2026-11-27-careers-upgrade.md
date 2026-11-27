# Secure Careers Implementation Plan

> **For agentic workers:** use the subagent implementation workflow for independent tasks and a final security/code review. Work only in the isolated Careers checkout.

**Goal:** Deliver public Careers forms, secure private CV persistence, and authenticated candidate review.

**Architecture:** Preserve the existing Astro/CMS architecture and extend the Cloudflare Worker. R2 stores private files; D1 stores applications and hero settings. Application retrieval occurs only at authenticated runtime.

**Tech Stack:** Astro 5, TypeScript, Tailwind, Cloudflare Workers/D1/R2, Resend, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-27-careers-design.md`

## Global Constraints

- Maximum CV size `5 * 1024 * 1024`; PDF, DOC and DOCX only, extension plus byte validation.
- D1 acknowledgment requires `success === true && meta?.changes === 1`.
- Brand blue `#1D4ED8` / `#2563EB`; preserve global CSS and Virex conventions.
- No candidate data in generated HTML, localStorage, logs, or unsafe HTML sinks.
- Maintain existing CMS Bearer authentication and role editing contracts.

## Review Focus

- Malformed archives and lying multipart lengths must remain bounded.
- Email failure must preserve saved applications; failed inserts must not leave acknowledged submissions.
- Expired/fabricated admin tokens must never reach D1/R2 application reads.
- Malicious URLs/filenames must remain inert in browser, email and response headers.
- Mobile layout and image errors must preserve the reserved hero frame.

### Task 1: CV validation

**Files:** `src/lib/server/career-cv.ts`, `tests/career-cv.test.mjs`.
**Interface:** `validateCareerCv(file: File): Promise<ValidatedCareerCv | null>` as defined in the spec.

- [x] Add failing tests for supported formats, mismatches, empty/oversize files, malformed/encrypted/non-Word archives, and safe filenames.
- [x] Implement bounded magic-byte and structural checks without trusting file.type.
- [x] Run focused tests and report evidence.

### Task 2: Edge persistence and admin APIs

**Files:** `functions/api/careers/*`, `src/lib/server/careers-*.ts`, `src/lib/server/edge-security.ts`, `src/worker.ts`, `sql/markchat-careers.sql`, `wrangler.jsonc`, `tests/careers-api.test.mjs`.
**Interfaces:** Application endpoints from the spec; export `requireCareersAdmin(context): Promise<Response | null>` for hero settings mutations.

- [x] Write failing tests for origin/rate/auth, confirmed persistence, R2 rollback, Resend failure and attachment headers.
- [x] Implement bounded multipart validation and canonical role resolution, private storage, D1 queries, safe notifications, status mutation and CV downloads.
- [x] Add migration and distinct production/preview R2 bindings.
- [x] Run focused tests and report evidence.

### Task 3: Public Careers UI

**Files:** `src/pages/careers.astro`, `src/pages/careers/[slug].astro`, `src/components/careers/CareerApplicationForm.astro`, `src/lib/careers-form.ts`, `tests/careers-ui.test.mjs`.
**Interfaces:** Existing CMS public catalog plus `fetchHeroMediaSettings('careers')`; submit via `submitCareerApplication(careerId, FormData)` with real files.

- [x] Cover form validation and submission failures with focused tests.
- [x] Implement split hero, floating cards, flow-safe filters and shared accessible multipart form.
- [x] Retain existing route metadata/schema and verify mobile layout.

### Task 4: CMS, hero media and integration

**Files:** `src/lib/cms-api.ts`, `src/lib/types.ts`, `src/lib/hero-media.ts`, `src/components/design-system/MCResponsiveHeroMedia.astro`, `src/components/dashboard/MCHeroMediaEditor.astro`, `src/pages/dashboard/careers.astro`, new dashboard application component, hero API and tests, bundled image, deployment docs.

- [x] Replace Careers application local success fallbacks with durable edge calls and retain exported client functions.
- [x] Add authenticated dynamic application review with status/search/pagination and safe downloads.
- [x] Add durable Careers hero settings, strict URL validation, focal settings and reserved responsive picture.
- [x] Convert the supplied photo to bundled WebP and verify image dimensions.
- [x] Run `npm run check`, `npm run build`, `npm test`; inspect representative layouts, review diff, and record live deployment prerequisites.

## Completion evidence — 27 November 2026

- `npm run check`: passed ESLint and Prettier; Astro checked 221 files with 0 errors, warnings or hints.
- `npm run build`: passed; 168 static pages generated.
- `npm test`: 272 passed, 0 failed, 0 skipped.
- `npx wrangler deploy --dry-run --outdir /tmp/markchat-careers-worker-dry-run`: passed with the D1, R2 and assets bindings; no deployment performed.
- Chromium: light/dark views at 320, 390 and 1440px; overflow, filters, keyboard/native form controls, upload removal, multipart success/failure retention, authenticated candidate review, status rollback, safe rendering and private downloads exercised. Reserved hero frames measured zero initial and delayed-override layout shift at 390 and 1440px, including image failures.
- Local Wrangler 4.169.0/workerd: genuine PDF, DOC and DOCX uploads returned 201, produced matching local D1 rows and round-tripped identical R2 bytes. Invalid upload returned 400; anonymous listing and CV access returned 401. No live services or notifications were used.
- Independent review closed four findings: ambiguous D1 acknowledgement cleanup, false CMS mutation success, search query logging, and inconsistent professional-link validation.

## Final implementation decisions

- Preserve a CV when D1 acknowledgement is uncertain and a matching row exists or reconciliation fails. Delete only after a primary read confirms absence; still return 503 unless the original insert was positively confirmed.
- Accept role CMS mutation success only after an explicit positive response, a matching saved resource, or HTTP 204. Explain that role changes need a static site rebuild; hero settings update at runtime.
- Redact query strings from production and preview Worker logs/traces so candidate searches are not recorded as request URLs.
- Exclude generated Wrangler artifacts from source checks and commits; ignore local development secret files.
- Preserve the isolated branch and prepare a draft PR against `feat/d1-durable-marketing-leads`. Production promotion remains separate from this implementation.

See `docs/CAREERS-CLOUDFLARE.md` for provisioning, authorization checks and live verification prerequisites.
