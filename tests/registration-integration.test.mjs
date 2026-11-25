/**
 * MarkChat Batch 5: Registration & Provisioning Integration Verification Tests
 *
 * Verifies that the marketing registration frontend integrates directly with the
 * Control Plane registration saga API (/api/v1/registration), ensures durable
 * idempotency, implements polling for asynchronous provisioning, handles SSO
 * redirection, and sanitizes errors without leaking stack traces.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const marketingRoot = path.resolve(__dirname, '..');

describe('Batch 5: Registration and Provisioning Integration', () => {
  const registerFormPath = path.join(
    marketingRoot,
    'src',
    'components',
    'forms',
    'RegisterForm.astro'
  );
  const registerFormSource = fs.readFileSync(registerFormPath, 'utf8');

  test('RegisterForm includes API URL data attribute and honeypot field', () => {
    assert.match(
      registerFormSource,
      /data-api-url=\{controlPlaneUrl\}/,
      'Form must include data-api-url configured for Control Plane API'
    );
    assert.match(
      registerFormSource,
      /name="_gotcha"/,
      'Form must include hidden honeypot input for anti-bot defense'
    );
  });

  test('RegisterForm submit handler generates and persists Idempotency-Key in sessionStorage', () => {
    assert.match(
      registerFormSource,
      /sessionStorage\.getItem\(['"]markchat_reg_idempotency_key['"]\)/,
      'Must check sessionStorage for durable idempotency key'
    );
    assert.match(
      registerFormSource,
      /'Idempotency-Key':\s*idempotencyKey/,
      'Must inject Idempotency-Key header into registration request'
    );
    assert.match(
      registerFormSource,
      /sessionStorage\.setItem\(['"]markchat_reg_idempotency_key['"]/,
      'Must persist generated key in sessionStorage'
    );
  });

  test('Form payload matches Control Plane registration contract', () => {
    // Check that all required contract fields are gathered
    assert.match(registerFormSource, /businessName/, 'Payload must contain businessName');
    assert.match(registerFormSource, /fullName/, 'Payload must contain fullName');
    assert.match(registerFormSource, /email/, 'Payload must contain email');
    assert.match(registerFormSource, /password/, 'Payload must contain password');
    assert.match(registerFormSource, /planId/, 'Payload must contain planId');

    // Verify endpoint path
    assert.match(
      registerFormSource,
      /\/api\/v1\/registration/,
      'Must dispatch to /api/v1/registration'
    );
  });

  test('KES 82 verification exchanges signed capability for hosted checkout', () => {
    assert.ok(registerFormSource.includes('data.verificationRequired === true'));
    assert.ok(registerFormSource.includes('data.verificationToken'));
    assert.ok(registerFormSource.includes('/verification-checkout'));
    assert.ok(registerFormSource.includes('Authorization: `Bearer'));
    assert.ok(registerFormSource.includes('checkout?.amountKesCents !== 8200'));
    assert.ok(registerFormSource.includes("checkout?.currency !== 'KES'"));
    assert.ok(registerFormSource.includes('window.location.assign(checkout.authorizationUrl)'));
    assert.ok(registerFormSource.includes('markchat_verification_pending'));
    assert.ok(!registerFormSource.includes("sessionStorage.setItem('markchat_verificationToken'"));
  });

  test('Completed registration and an existing pending checkout never trigger a second charge', () => {
    assert.ok(
      registerFormSource.indexOf("if (data.status === 'completed')") <
        registerFormSource.indexOf('if (data.verificationRequired === true)')
    );
    assert.ok(registerFormSource.includes("const previousRaw = sessionStorage.getItem('markchat_verification_pending')"));
    assert.ok(registerFormSource.includes("previous?.registrationId === registrationId"));
    assert.ok(registerFormSource.includes("window.location.assign('/billing/return')"));
  });

  test('Verification-disabled registration retains bounded saga polling', () => {
    assert.ok(registerFormSource.includes('Verification is OFF: proceed with standard saga polling'));
    assert.ok(registerFormSource.includes('pollRegistrationStatus(apiUrl, registrationId, redirectTarget)'));
    assert.ok(registerFormSource.includes('KES 82 is charged to confirm payment ownership'));
    assert.ok(registerFormSource.includes('automatically refunded within 3 days'));
  });

  test('Registration remains Core-only Starter, Growth and Scale', () => {
    assert.ok(!registerFormSource.includes('enterprise: {'));
    assert.ok(!registerFormSource.includes('Launch SMS Studio'));
  });

  test('Asynchronous saga polling loop handles status lifecycle', () => {
    assert.match(
      registerFormSource,
      /\/api\/v1\/registration\/\$\{registrationId\}/,
      'Must query registration status endpoint during polling'
    );
    assert.match(
      registerFormSource,
      /statusData\.status === 'completed'/,
      'Must check for completed saga status'
    );
    assert.match(
      registerFormSource,
      /statusData\.status === 'failed'/,
      'Must check for failed saga status'
    );
    assert.match(
      registerFormSource,
      /maxAttempts/,
      'Must enforce a bounded maximum polling count to prevent infinite polling'
    );
  });

  test('Safe post-registration login redirect and error sanitization integrity', () => {
    assert.match(
      registerFormSource,
      /completeRegistration\(redirectTarget\)/,
      'Completed provisioning must lead to the registration completion handler'
    );
    assert.match(
      registerFormSource,
      /const destination = '\/login\?redirect=' \+ encodeURIComponent\(redirectTarget\)/,
      'Registration must lead to local login with an encoded redirect target'
    );
    assert.doesNotMatch(
      registerFormSource,
      /window\.location\.href\s*=\s*(?:statusData|data)\.ssoUrl/,
      'Untrusted Control Plane SSO URLs must not be used as browser navigation targets'
    );
    assert.match(
      registerFormSource,
      /sessionStorage\.removeItem\(['"]markchat_reg_idempotency_key['"]\)/,
      'Must clear idempotency key upon successful provisioning'
    );
    assert.match(
      registerFormSource,
      /!errData\.message\.includes\(['"]stack['"]\)/,
      'Must sanitize error messages to prevent exposing stack traces to customers'
    );
  });
});
