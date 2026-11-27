# Secure Careers upgrade

## Intent and scope

Implement the supplied Careers specification in `markchat-marketing` only, based on the durable D1 branch at `83cc24d`. Preserve Astro static generation, Virex typography, Tailwind, light/dark mode, existing CMS role editing, and both dashboard aliases. Do not change global CSS or other repositories. Do not promote production while the existing D1 preview work is pending.

## Architecture

The public Careers pages share one accessible multipart application form. A submitted CV is required; professional links are optional. The edge API validates bounded input, checks origin, D1 rate limits and consent, validates file structure, saves private R2 bytes, and confirms one D1 application insert before acknowledging success. Resend follows persistence; notification failure leaves the application available to administrators. An unconfirmed insert returns an error and is reconciled against the D1 primary before any CV cleanup. The object is retained when a matching row exists or reconciliation is unavailable; it is deleted only after confirming no matching row exists.

Application details are loaded after authentication at runtime, never embedded in static dashboard HTML or persisted in browser storage. All admin API actions validate the current CMS Bearer/session token against the existing protected CMS applications endpoint; missing or unavailable verification fails closed. Downloads are attachments with restrictive CSP and cache controls.

The existing hero media settings and picture renderer gain a Careers entry with the provided bundled office photo. Careers hero overrides are stored durably in D1 through additive edge routes and loaded inside a reserved image frame at runtime. The CMS bridge image upload contract remains available. This avoids depending on an unimplemented upstream hero publishing endpoint. URLs are same-origin image paths or approved HTTPS origins, with traversal and executable schemes rejected. Desktop/mobile focal settings are bounded percentages.

## Contracts

- `POST /api/careers/apply`: multipart fields `careerId`, `careerTitle`, `specialization`, `fullName`, `email`, `phone`, `location`, `linkedinUrl`, `githubUrl`, `portfolioUrl`, `coverLetter`, `consent` (literal `true`), `website` (empty honeypot), `startedAt` (epoch milliseconds), `cv` (required File). Server resolves role titles from the published catalog, ignoring claimed role titles.
- `GET /api/careers/applications?status=&search=&limit=25&offset=0&id=`: authenticated `{success, applications, total, limit, offset}`. Items retain existing camelCase CMS fields and add `specialization`, `githubUrl`, `cvFilename`, `cvSize`, `cvMime`, `notificationSent`, and `hasCv`.
- `PATCH /api/careers/applications/:id`: authenticated same-origin JSON `{status}`. Canonical statuses `new`, `shortlisted`, `interview`, `rejected`, `hired`; client maps legacy `reviewed`/`contacted` without a false success fallback.
- `GET /api/careers/cv/:id`: authenticated private attachment. UUID application IDs only; no R2 keys returned in listing responses.
- `GET /api/careers/hero`: public normalized `HeroMediaSettings`.
- `PUT /api/careers/hero`: authenticated same-origin normalized settings, confirmed D1 upsert.
- CV validator: `validateCareerCv(file: File): Promise<ValidatedCareerCv | null>` returns `{bytes: Uint8Array, extension: 'pdf'|'doc'|'docx', mime: string, filename: string}`. Maximum `5 * 1024 * 1024` bytes. Both extension and file structure must match; MIME claims do not establish trust.

## Design decisions

Use the existing private edge architecture instead of posting CVs to a public asset directory or treating email/browser storage as persistence. Keep the header and department controls in separate flow layers. Use solid brand blue, restrained floating shadows, reduced-motion support and high-contrast form surfaces. Download documents instead of embedding untrusted document content in the dashboard.

## Verification and operational boundaries

Exercise valid/invalid file formats, oversized/chunked bodies, honeypots/dwell/consent, rate failures, R2 and D1 failures, email failures, admin auth failures, injection payloads and URL traversal. Run check, build, and the full test suite. Inspect desktop/mobile and light/dark layouts with browser-based tests when available. Provide SQL, distinct production/preview bucket bindings, deployment instructions, and state clearly which live services were not exercised.
