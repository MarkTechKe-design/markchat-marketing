/** Isolated browser smoke tests. All Control Plane and hosted checkout requests are fixtures. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

let playwright;
try {
  playwright = await import('playwright');
} catch {
  if (!process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) {
    throw new Error('Install Playwright locally to run this optional browser smoke test.');
  }
  playwright = createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + '/package.json')(
    'playwright'
  );
}
const base = process.env.ONBOARDING_TEST_URL || 'http://127.0.0.1:4322';
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;
const browser = await playwright.chromium.launch({
  headless: true,
  executablePath,
  args: ['--no-sandbox'],
});
const password = 'Smoke9!ExamplePassphrase';
const envelope = (data) => ({ success: true, data });
let preview;

async function setup({
  trialHours = 720,
  verificationRequired = false,
  unavailable = false,
  ssoUrl = null,
} = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  let phase = 'initial';
  const paymentAttempts = new Map();
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/v1/')) {
      const headers = {
        'access-control-allow-origin': new URL(base).origin,
        'access-control-allow-credentials': 'true',
        'access-control-allow-headers': 'Content-Type,Authorization,Idempotency-Key',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      };
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers });
        return;
      }
      const body = request.postDataJSON();
      requests.push({
        path: url.pathname,
        method: request.method(),
        body,
        authorization: request.headers().authorization,
      });
      let response;
      let status = 200;
      if (url.pathname.endsWith('/registration/options')) {
        if (unavailable) {
          status = 503;
          response = { success: false };
        } else
          response = envelope({
            trialHours,
            verificationRequired,
            verificationAmountKesCents: 8200,
            otp: { channel: 'email', expiresInSeconds: 600, resendAfterSeconds: 60 },
          });
      } else if (url.pathname.endsWith('/otp/send')) {
        assert.deepEqual(body, { email: 'owner@example.com', channel: 'email' });
        response = envelope({
          challengeId: 'fixture-challenge',
          expiresInSeconds: 600,
          resendAfterSeconds: 60,
        });
      } else if (url.pathname.endsWith('/otp/verify')) {
        assert.deepEqual(body, {
          email: 'owner@example.com',
          challengeId: 'fixture-challenge',
          code: '123456',
        });
        response = envelope({ otpVerificationToken: 'signed.email.proof', expiresInSeconds: 600 });
      } else if (url.pathname === '/api/v1/registration') {
        assert.equal(body.otpVerificationToken, 'signed.email.proof');
        response = envelope({
          registrationId: 'fixture-registration',
          status: 'pending',
          trialHours,
          verificationRequired,
          verificationToken: 'fixture-checkout-capability',
          sessionToken: 'fixture-session-capability',
        });
      } else if (url.pathname.endsWith('/fixture-registration/session')) {
        assert.equal(request.headers().authorization, 'Bearer fixture-session-capability');
        response = envelope({
          token: 'fixture.customer.session',
          ssoUrl,
          user: { id: 'fixture-customer' },
          redirectTarget: '/billing',
        });
      } else if (
        url.pathname.endsWith('/verification-checkout') ||
        url.pathname.endsWith('/subscription-checkout')
      ) {
        assert.equal(request.headers().authorization, 'Bearer fixture-checkout-capability');
        assert.deepEqual(body, { paymentMethod: 'mpesa' });
        const verification = url.pathname.endsWith('/verification-checkout');
        response = {
          success: true,
          checkout: {
            reference: verification ? 'verification-reference' : 'subscription-reference',
            authorizationUrl:
              'https://checkout.paystack.com/' + (verification ? 'verification' : 'subscription'),
            amountKesCents: verification ? 8200 : 350000,
            currency: 'KES',
          },
        };
        const purpose = verification ? 'account_verification' : 'subscription';
        paymentAttempts.set(purpose, { ...response.checkout, purpose });
      } else if (url.pathname.includes('/fixture-registration/payments')) {
        assert.equal(request.headers().authorization, 'Bearer fixture-checkout-capability');
        const reference = url.pathname.split('/payments/')[1];
        const attempt = reference
          ? [...paymentAttempts.values()].find((payment) => payment.reference === reference)
          : paymentAttempts.get(url.searchParams.get('purpose'));
        const paid =
          phase === 'complete' ||
          (attempt?.purpose === 'account_verification' && phase === 'verification-paid');
        response = envelope(
          attempt
            ? {
                ...attempt,
                status: paid ? 'success' : 'pending',
                retryAllowed: false,
                authorizationUrl: paid ? null : attempt.authorizationUrl,
                requiresReconciliation: false,
              }
            : null
        );
      } else if (url.pathname.endsWith('/fixture-registration')) {
        const verification = verificationRequired && phase === 'initial';
        const subscription = trialHours === 0 && phase !== 'complete';
        response = envelope({
          status: !verification && !subscription ? 'completed' : 'pending',
          trialHours,
          paymentRequirements: { verification, subscription },
        });
      } else if (
        url.pathname.endsWith('/auth/login') ||
        url.pathname.endsWith('/auth/google/exchange')
      ) {
        response = envelope({
          token: 'fixture.customer.session',
          ssoUrl,
          redirect: '/billing',
          isNewUser: false,
        });
      } else {
        status = 500;
        response = { success: false, message: 'Unexpected fixture route' };
      }
      await route.fulfill({
        status,
        headers,
        contentType: 'application/json',
        body: JSON.stringify(response),
      });
      return;
    }
    if (url.origin === new URL(base).origin) {
      await route.continue();
      return;
    }
    if (
      url.origin === 'https://app.markchat.co.ke' ||
      url.origin === 'https://checkout.paystack.com'
    ) {
      await route.fulfill({ contentType: 'text/html', body: '<h1>Isolated handoff fixture</h1>' });
      return;
    }
    await route.abort();
  });
  return {
    context,
    page,
    requests,
    errors,
    setPhase: (value) => {
      phase = value;
    },
  };
}

async function fillVerifiedRegistration(page) {
  await page.goto(base + '/register?plan=growth&interval=monthly');
  await page.locator('#businessName').fill('Example Business');
  await page.locator('#fullName').fill('Example Owner');
  await page.locator('#registerEmail').fill('Owner@Example.COM');
  await page.locator('#btn-continue-step1').click();
  assert.equal(
    await page.locator('#step-1-container').isVisible(),
    true,
    'unverified email must not advance'
  );
  await page.locator('#send-email-otp').click();
  await page.locator('#emailOtpCode').fill('123456');
  await page.locator('#verify-email-otp').click();
  await page.waitForFunction(() =>
    document.getElementById('email-otp-status').textContent.includes('Your email is verified')
  );
  await page.locator('#btn-continue-step1').click();
  await page.locator('#registerPassword').fill(password);
  await page.locator('#confirmPassword').fill(password);
  await page.locator('#agreeTerms').check();
}

async function assertSession(page) {
  await page.goto(base + '/billing');
  assert.deepEqual(
    await page.evaluate(() => [
      localStorage.getItem('markchat_cp_token'),
      sessionStorage.getItem('markchat_cp_token'),
    ]),
    ['fixture.customer.session', 'fixture.customer.session']
  );
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem('markchat_registration_session')),
    null
  );
}

try {
  if (!process.env.ONBOARDING_TEST_URL) {
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(4322, '127.0.0.1', resolve);
    });
    await new Promise((resolve) => probe.close(resolve));
    preview = spawn(
      process.execPath,
      ['node_modules/astro/astro.js', 'preview', '--host', '127.0.0.1', '--port', '4322'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let previewOutput = '';
    preview.stdout.on('data', (chunk) => {
      previewOutput += String(chunk);
    });
    preview.stderr.on('data', (chunk) => {
      previewOutput += String(chunk);
    });
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (preview.exitCode !== null) break;
      try {
        if ((await fetch(base, { signal: AbortSignal.timeout(500) })).ok) {
          ready = true;
          break;
        }
      } catch {
        /* Await the owned preview. */
      }
      await delay(100);
    }
    if (!ready)
      throw new Error(
        'Build the site before the browser smoke test. Preview failed: ' +
          previewOutput.slice(-1000)
      );
  }
  {
    const fixture = await setup({
      ssoUrl: 'https://app.markchat.co.ke/app/accounts/12/dashboard?token=fixture',
    });
    await fillVerifiedRegistration(fixture.page);
    assert.match(
      await fixture.page.locator('#registration-policy').textContent(),
      /30 days free trial/
    );
    assert.doesNotMatch(await fixture.page.locator('#registration-policy').textContent(), /82/);
    await fixture.page.locator('#register-submit-button').click();
    await fixture.page.waitForURL(
      'https://app.markchat.co.ke/app/accounts/12/dashboard?token=fixture'
    );
    assert.equal(fixture.requests.filter((r) => r.path.endsWith('-checkout')).length, 0);
    assert.equal(fixture.requests.filter((r) => r.path.endsWith('/auth/login')).length, 0);
    await assertSession(fixture.page);
    assert.deepEqual(fixture.errors, []);
    await fixture.context.close();
    console.log('PASS free default: OTP, no payment, automatic SSO, dual storage');
  }
  {
    const fixture = await setup({ trialHours: 0 });
    await fillVerifiedRegistration(fixture.page);
    assert.match(await fixture.page.locator('#registration-policy').textContent(), /No free trial/);
    await fixture.page.locator('#register-submit-button').click();
    await fixture.page.waitForURL('https://checkout.paystack.com/subscription');
    fixture.setPhase('complete');
    await fixture.page.goto(base + '/billing/return?reference=subscription-reference');
    await fixture.page.waitForURL(
      (url) => url.pathname === '/billing' && url.searchParams.get('plan') === 'growth'
    );
    assert.equal(
      fixture.requests.filter((r) => r.path.endsWith('/verification-checkout')).length,
      0
    );
    assert.equal(fixture.requests.filter((r) => r.path.includes('/billing/status/')).length, 0);
    await assertSession(fixture.page);
    assert.deepEqual(fixture.errors, []);
    await fixture.context.close();
    console.log(
      'PASS zero trial: subscription checkout, payment return, authenticated billing fallback'
    );
  }
  {
    const fixture = await setup({ trialHours: 0, verificationRequired: true });
    await fillVerifiedRegistration(fixture.page);
    await fixture.page.locator('#register-submit-button').click();
    await fixture.page.waitForURL('https://checkout.paystack.com/verification');
    fixture.setPhase('verification-paid');
    await fixture.page.goto(base + '/billing/return?reference=verification-reference');
    await fixture.page.locator('#continue-registration-payment').click();
    await fixture.page.waitForURL('https://checkout.paystack.com/subscription');
    fixture.setPhase('complete');
    await fixture.page.goto(base + '/billing/return?reference=subscription-reference');
    await fixture.page.waitForURL(
      (url) => url.pathname === '/billing' && url.searchParams.get('plan') === 'growth'
    );
    assert.equal(
      fixture.requests.filter((r) => r.path.endsWith('/verification-checkout')).length,
      1
    );
    assert.equal(
      fixture.requests.filter((r) => r.path.endsWith('/subscription-checkout')).length,
      1
    );
    await assertSession(fixture.page);
    assert.deepEqual(fixture.errors, []);
    await fixture.context.close();
    console.log('PASS both gates: verification then subscription, one checkout each');
  }
  {
    const fixture = await setup({ unavailable: true });
    await fixture.page.goto(base + '/register');
    await fixture.page.locator('#retry-registration-options').waitFor({ state: 'visible' });
    assert.equal(await fixture.page.locator('#send-email-otp').isDisabled(), true);
    assert.equal(await fixture.page.locator('#register-submit-button').isDisabled(), true);
    assert.doesNotMatch(
      await fixture.page.locator('#registration-policy').textContent(),
      /30 days|No payment/
    );
    assert.deepEqual(fixture.errors, []);
    await fixture.context.close();
    console.log('PASS unavailable policy: no invented trial and signup blocked');
  }
  {
    const fixture = await setup({ ssoUrl: 'https://app.markchat.co.ke/app/%252e%252e/admin' });
    await fixture.page.goto(base + '/login?redirect=%2Fbilling%3Fplan%3Dscale');
    await fixture.page.locator('#email').fill('owner@example.com');
    await fixture.page.locator('#password').fill(password);
    await fixture.page.locator('#login-submit-button').click();
    await fixture.page.waitForURL(
      (url) => url.pathname === '/billing' && url.searchParams.get('plan') === 'scale'
    );
    await assertSession(fixture.page);
    assert.deepEqual(fixture.errors, []);
    await fixture.context.close();
    console.log('PASS login: malicious SSO rejected and safe billing intent retained');
  }
  {
    const fixture = await setup();
    await fixture.page.goto(base + '/auth/callback?ticket=' + 'a'.repeat(43));
    await fixture.page.waitForURL((url) => url.pathname === '/billing');
    const exchange = fixture.requests.find((r) => r.path.endsWith('/auth/google/exchange'));
    assert.deepEqual(exchange.body, { ticket: 'a'.repeat(43) });
    await assertSession(fixture.page);
    assert.deepEqual(fixture.errors, []);
    await fixture.context.close();
    console.log('PASS existing Google flow: browser ticket exchange and dual storage retained');
  }
} finally {
  await browser.close();
  preview?.kill();
}
