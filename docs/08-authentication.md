# Customer authentication and onboarding

The customer routes use the existing Virex `AuthLayout`, form components, semantic colors, spacing, and light/dark styles. Customer credentials and tokens are separate from the marketing CMS administrator session. This implementation does not change Chatwoot Core, SMS Studio, or other account boundaries.

## Routes and shared helpers

| Route or file | Responsibility |
| --- | --- |
| `/register`, `RegisterForm.astro` | Two-step business/account form, email verification, live trial terms, registration progress and automatic session handoff |
| `/login`, `LoginForm.astro` | Existing email/password login and Google entry point |
| `/auth/callback` | Browser-bound Google ticket exchange; URL fragments are rejected and ticket state is scrubbed |
| `/billing` | Authenticated subscription checkout using the saved customer token |
| `/billing/return` | Resume initial registration payment gates or read an authenticated subscription receipt |
| `src/lib/customer-session.ts` | Customer token persistence, storage fallback, local redirect validation and Core SSO validation |
| `src/lib/registration-client.ts` | OTP state, registration settings, capability storage, payment gates and session exchange |

The API base comes from `PUBLIC_CONTROL_PLANE_URL`, with `PUBLIC_CONTROL_PLANE_API_URL` retained as a compatibility alias. Development defaults to `http://localhost:5000`. Production requires an explicitly configured HTTPS Control Plane and matching CORS origins.

## Live registration policy

`GET /api/v1/registration/options` returns:

```json
{
  "success": true,
  "data": {
    "trialHours": 720,
    "verificationRequired": false,
    "verificationAmountKesCents": 8200,
    "otp": {
      "channel": "email",
      "expiresInSeconds": 600,
      "resendAfterSeconds": 60
    }
  }
}
```

The Control Plane default is 720 hours, displayed as 30 days. Other configured durations are formatted from the response. An explicit zero means no free trial and requires an initial paid subscription. The configured confirmation amount remains in this response when verification is disabled; it is displayed or collected only if the verification gate is enabled. The browser does not substitute a default when this request fails or returns malformed policy: it shows an unavailable state, offers retry, and blocks signup until terms are confirmed.

With verification disabled and a positive trial duration, no checkout is opened. Account-confirmation charges are presented only when `verificationRequired` is explicitly enabled. When both payment verification and a zero-length trial apply, the confirmation and subscription gates must each settle before activation. Annual checkout remains unavailable.

## Six-digit email verification

1. `POST /api/v1/registration/otp/send` receives `{email, channel: "email"}` and returns `{challengeId, expiresInSeconds, resendAfterSeconds}` in `data`.
2. `POST /api/v1/registration/otp/verify` receives `{email, challengeId, code}` and returns `{otpVerificationToken, expiresInSeconds}` in `data`.
3. `POST /api/v1/registration` receives the existing business/name/email/phone/password/plan fields plus `otpVerificationToken`, with the durable `Idempotency-Key` header.

The browser normalizes the email before each request. Verification accepts exactly six digits, honors the server resend cooldown, rejects expired state, and discards late responses for an address that has since changed. Changing the normalized address clears the challenge and proof. A rejected or already-used proof can be cleared for re-verification without resetting the send cooldown. Generic rate-limit responses use the JSON `retryAfter` value when cross-origin browser access hides the HTTP header. The OTP proof stays in memory and is never written into browser storage or a URL.

Existing Google customers retain the ticket exchange and session flow. New Google signup returns `GOOGLE_SIGNUP_EMAIL_VERIFICATION_REQUIRED` and is directed to the same verified-email registration flow. It must not create an unverified workspace as an alternative signup path.

Passwords follow the Control Plane contract: 8–255 characters, including uppercase, lowercase, a digit, and an accepted special character. The existing common-password checks remain in the form.

## Provisioning and session handoff

Registration returns a registration ID and a short-lived opaque `sessionToken`; optional payment gates also use the existing `verificationToken` checkout capability. The browser stores only these capabilities, the registration ID, creation time, and validated billing intent in `sessionStorage`. This record expires after 60 minutes. Passwords and OTP proofs are never persisted. The hosted-payment reference is stored separately with its purpose and checkout amount.

`GET /api/v1/registration/:id` reports provisioning status, `trialHours`, and `paymentRequirements: {verification, subscription}`. Each boolean indicates an outstanding payment gate. Verification takes priority, followed by subscription. A public status response never supplies a customer JWT or authorizes a session.

After `status: "completed"`, the browser calls:

```http
POST /api/v1/registration/:id/session
Authorization: Bearer <sessionToken>
Content-Type: application/json

{}
```

The authenticated response is `data: {token, ssoUrl, user, redirectTarget: "/billing"}`. A pending `409` remains in bounded provisioning retry. A successful session is saved as `markchat_cp_token` in both `localStorage` and `sessionStorage`. Either store can serve as a fallback if the other is unavailable. Stale credentials are not intentionally left behind during a partial storage update.

For the free flow on the original form, a missing or expired capability can fall back to the existing password login endpoint using credentials still held by that submit handler. A returned payment page has no stored password, so an expired proof needs sign-in or support. The interface must not claim an automatic session if no verified token was received.

## Optional payment and return behavior

Both capability-protected checkout routes accept `{paymentMethod: "mpesa"}` and return `{success: true, checkout: {reference, authorizationUrl, amountKesCents, currency}}`:

- `POST /api/v1/registration/:id/verification-checkout`
- `POST /api/v1/registration/:id/subscription-checkout`

The browser validates the hosted URL, KES currency, positive integer amount and opaque reference before navigation. Checkout URLs must use `https://checkout.paystack.com`, the default HTTPS port and a nonempty path, with no credentials, fragment, whitespace, backslashes or control characters. URLs longer than 2048 characters are rejected. Capabilities never appear in query strings.

Recovery uses the same registration checkout capability in the `Authorization: Bearer` header:

- `GET /api/v1/registration/:id/payments/:reference` checks a saved reference.
- `GET /api/v1/registration/:id/payments?purpose=subscription|account_verification` discovers the latest attempt when the initialization response was lost or a previous failure may have been superseded.

Both return `data: {reference, status, purpose, amountKesCents, currency, retryAllowed, authorizationUrl, requiresReconciliation}`. Discovery returns `data: null` only when the server has no recorded attempt. A saved reference must match the response reference, purpose and amount; the server separately enforces registration and tenant ownership. A failed saved reference is followed by discovery before a replacement is considered, so a newer pending attempt is recovered rather than charged again.

If the provider returns a reference that the browser never saved, the return page first recovers it through the capability-protected reference lookup. Its purpose can belong to an earlier settled gate: for example, a verified account-confirmation payment can be restored before discovery advances to the separate subscription gate. A query-string reference alone never authorizes payment or identity.

| Authoritative payment state | Browser action |
| --- | --- |
| Pending with a persisted, valid hosted URL | Resume that same checkout; do not initialize another payment. |
| Pending without a hosted URL, or reconciliation required | Show awaiting-confirmation/support guidance; retain the attempt and do not charge again. |
| Success | Continue checking registration activation and session readiness. |
| Failed or abandoned, with `retryAllowed: true` | Offer **Retry payment**. Recheck the server on the click before replacing the confirmed failed reference. |
| No attempt recorded after a lost initialization response | Offer **Retry connection**. Recheck discovery and require the explicit action before another initialization request. |
| Lookup error, invalid response, or mismatched scope | Retain the saved reference and block another charge. |

A minimal initialization intent is written to `sessionStorage` before each checkout POST. It contains only registration ID, purpose, the previous failed reference if any, and creation time. This prevents an automatic repeat after a lost response even when the browser never received a new reference. An explicit connection retry is safe only after successful discovery establishes no new active attempt: the Control Plane's pending/success database constraint serializes initializations before provider contact, including when an older request arrives late. A page reload, browser cancellation, elapsed time, or request error never establishes payment failure. The recovery GET routes read persisted state; they do not contact the payment provider to manufacture a terminal outcome.

Before a customer JWT exists, the return page relies on registration progress to determine whether provisioning or another payment gate is outstanding. It does not use public transaction lookup as identity proof. If a second gate remains, the user can continue to that payment. When setup completes, the saved session capability is exchanged and the customer enters the validated destination automatically.

Ordinary subscription receipts require a saved customer token. Receipt confirmation does not trust or navigate to an SSO URL supplied by a transaction record. Server-side authorization of receipt access remains the Control Plane's responsibility.

## Redirect security

The shared SSO validator allows the production Core origin with an `/app/` path. The two HTTP development origins are allowed only when the marketing page itself is served from `localhost`, `127.0.0.1`, or `[::1]`:

- `https://app.markchat.co.ke`
- `http://localhost:3000`
- `http://127.0.0.1:3000`

It checks the original path before URL normalization and rejects credentials, raw dot traversal, encoded/double-encoded path segments, backslashes, duplicate slashes, control characters, and fragments. Valid SSO query parameters remain intact. A missing or rejected SSO falls back to the validated local billing route, preserving selected plan/interval intent. Local redirect validation rejects external, protocol-relative, escaped, and traversal paths.

The Google callback still requires a browser-bound one-use ticket, sends credentials to the exchange endpoint, scrubs the selector before making requests, and never accepts a JWT or SSO link from URL query/fragment fields.

## Verification and environment limits

Run `npm run check`, then `npm run build`, then `npm test`. The full test runner owns its Astro preview on port 4321. Executable tests cover email binding, exact OTP shape, expiry/resend/stale responses, policy zero/unavailable cases, session capability storage, checkout routing and recovery, lost initialization responses, explicit retry, retained ambiguous payments, dual customer-token storage, and hostile redirects. Component wiring checks preserve the existing Virex, OAuth and account boundaries.

An additional `node scripts/test-onboarding-browser.mjs` smoke test uses an installed Playwright/Chromium runtime and owns a preview on port 4322. It exercises the free flow, zero-trial subscription, both payment gates, unavailable settings, unsafe SSO fallback, and existing Google callback. All API and provider traffic is intercepted with deterministic fixtures; it never creates a real account or payment. Set `ONBOARDING_TEST_URL` to use a separately owned preview, or `CHROMIUM_EXECUTABLE_PATH` to select an installed browser. Browser dependencies are optional and are not added to the application bundle.

These checks do not prove live email delivery, Paystack settlement, or a configured Core SSO provider. Staging acceptance must use approved provider credentials and the deployed Control Plane contract. No frontend fallback can invent provider availability or bypass server verification.
