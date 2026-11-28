/** Wiring checks complement executable session/OTP/policy tests in registration-client.test.mjs. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const form = fs.readFileSync('src/components/forms/RegisterForm.astro', 'utf8');
const page = fs.readFileSync('src/pages/register.astro', 'utf8');

describe('Verified registration and automatic customer handoff', () => {
  test('registration retains Virex form controls, honeypot, and the configured API boundary', () => {
    assert.match(form, /data-api-url=\{controlPlaneUrl\}/);
    assert.match(form, /name="_gotcha"/);
    for (const name of ['businessName', 'fullName', 'email', 'password', 'planId']) {
      assert.ok(form.includes('name="' + name + '"'));
    }
    assert.ok(!form.includes('enterprise: {'));
    assert.ok(!form.includes('Launch SMS Studio'));
  });

  test('the wizard offers accessible six-digit email verification and submits the signed proof', () => {
    for (const attribute of [
      'id="send-email-otp"',
      'id="verify-email-otp"',
      'autocomplete="one-time-code"',
      'inputmode="numeric"',
      'maxlength="6"',
    ]) {
      assert.ok(form.includes(attribute));
    }
    assert.ok(form.includes('emailVerification.token'));
    assert.ok(form.includes('otpVerificationToken:'));
    assert.ok(form.includes('emailVerification.setEmail(emailInput.value)'));
    assert.ok(form.includes('GOOGLE_SIGNUP_EMAIL_VERIFICATION_REQUIRED'));
  });

  test('registration retains a durable idempotency key and bounded provisioning checks', () => {
    assert.ok(form.includes("sessionStorage.getItem('markchat_reg_idempotency_key')"));
    assert.ok(form.includes("sessionStorage.setItem('markchat_reg_idempotency_key'"));
    assert.ok(form.includes("'Idempotency-Key': idempotencyKey"));
    assert.ok(form.includes('attempt < maxAttempts'));
    assert.ok(form.includes("statusData.status === 'completed'"));
    assert.ok(form.includes("statusData.status === 'failed'"));
  });

  test('trial and payment presentation uses live settings and server remaining gates', () => {
    assert.ok(form.includes('fetchRegistrationOptions(apiUrl)'));
    assert.ok(form.includes('formatTrialDuration(registrationOptions.trialHours)'));
    assert.ok(form.includes('registrationPaymentRequired(statusData.paymentRequirements)'));
    assert.ok(form.includes('prepareRegistrationPayment(apiUrl, registration, purpose,'));
    assert.ok(form.includes('readPendingRegistrationPayment()'));
    assert.ok(!form.includes('72-Hr Free Trial'));
    assert.ok(!page.includes('KES 82'));
  });

  test('payment recovery uses the shared scoped checks and a separate explicit retry action', () => {
    assert.ok(form.includes('id="retry-registration-payment"'));
    assert.ok(form.includes("progress.kind === 'retry'"));
    assert.ok(form.includes("progress.kind === 'connection_retry'"));
    assert.ok(form.includes('await beginPayment(registration, purpose, true)'));
    assert.ok(!form.includes('startRegistrationCheckout('));
    assert.ok(!form.includes('savePendingRegistrationPayment('));
    assert.ok(!form.includes("window.location.assign('/billing/return')"));
  });

  test('completed provisioning exchanges a session capability before the validated handoff', () => {
    assert.ok(form.includes('obtainRegistrationSession(apiUrl, registration, credentials)'));
    assert.ok(form.includes('persistCustomerSession(handoff.token)'));
    assert.ok(form.includes('customerDestination(handoff.ssoUrl, registration.redirectTarget)'));
    assert.ok(form.includes('saveRegistrationResume(currentRegistration)'));
    assert.ok(form.includes("sessionStorage.removeItem('markchat_reg_idempotency_key')"));
    assert.doesNotMatch(
      form,
      /window\.location\.(?:href|assign)\s*(?:=|\()\s*(?:statusData|data)\.ssoUrl/
    );
  });
});
