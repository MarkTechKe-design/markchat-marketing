import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EmailVerification,
  exchangeRegistrationSession,
  fetchRegistrationOptions,
  formatTrialDuration,
  obtainRegistrationSession,
  registrationPaymentRequired,
  registrationPasswordError,
  startRegistrationCheckout,
  readRegistrationResume,
  saveRegistrationResume,
} from '../src/lib/registration-client.ts';

const envelope = (data, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data }), { status });
const policy = (trialHours = 720, verificationRequired = false) => ({
  trialHours,
  verificationRequired,
  verificationAmountKesCents: 8200,
  otp: { channel: 'email', expiresInSeconds: 600, resendAfterSeconds: 60 },
});
const storage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
};

test('live registration settings preserve the configured trial and explicit zero', async () => {
  for (const hours of [720, 72, 1, 0]) {
    const result = await fetchRegistrationOptions('https://cp.example/', async (url, init) => {
      assert.equal(url, 'https://cp.example/api/v1/registration/options');
      assert.equal(init.cache, 'no-store');
      return envelope(policy(hours));
    });
    assert.equal(result.trialHours, hours);
    assert.equal(result.verificationRequired, false);
  }
  assert.equal(formatTrialDuration(720), '30 days');
  assert.equal(formatTrialDuration(72), '3 days');
  assert.equal(formatTrialDuration(36), '36 hours');
  assert.equal(formatTrialDuration(1), '1 hour');
  assert.equal(formatTrialDuration(0), null);
});

test('unavailable or malformed policy never invents a free trial', async () => {
  for (const response of [
    envelope({}, 503),
    envelope({}),
    envelope({ ...policy(), trialHours: -1 }),
    envelope({ ...policy(), verificationRequired: undefined }),
    envelope({ ...policy(), verificationRequired: true, verificationAmountKesCents: 0 }),
  ])
    await assert.rejects(
      fetchRegistrationOptions('https://cp.example', async () => response),
      /unavailable/i
    );
});

test('email OTP uses normalized identity, exact six digits, and the signed registration proof', async () => {
  let calls = 0;
  const fetcher = async (url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    if (url.endsWith('/send')) {
      assert.deepEqual(body, { email: 'person@example.com', channel: 'email' });
      return envelope({
        challengeId: 'challenge-1',
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
    }
    assert.deepEqual(body, {
      email: 'person@example.com',
      challengeId: 'challenge-1',
      code: '123456',
    });
    return envelope({ otpVerificationToken: 'signed.email.proof', expiresInSeconds: 600 });
  };
  const otp = new EmailVerification('https://cp.example', fetcher);
  otp.setEmail(' Person@Example.COM ');
  await otp.send();
  await assert.rejects(otp.verify('12345'), /six|6/i);
  assert.equal(calls, 1);
  await otp.verify('123456');
  assert.equal(otp.token, 'signed.email.proof');
  otp.setEmail('PERSON@example.com');
  assert.equal(otp.token, 'signed.email.proof');
  otp.setEmail('other@example.com');
  assert.equal(otp.token, null);
});

test('OTP expires and resend respects the server cooldown', async () => {
  let now = 1000;
  const otp = new EmailVerification(
    'https://cp.example',
    async (url) =>
      url.endsWith('/send')
        ? envelope({ challengeId: 'challenge-1', expiresInSeconds: 600, resendAfterSeconds: 60 })
        : envelope({ otpVerificationToken: 'signed.email.proof', expiresInSeconds: 600 }),
    () => now
  );
  otp.setEmail('person@example.com');
  await otp.send();
  await assert.rejects(otp.send(), /wait|resend/i);
  await otp.verify('123456');
  now += 600001;
  assert.equal(otp.token, null);
});

test('responses for an earlier email cannot verify a newly edited address', async () => {
  let release;
  const otp = new EmailVerification('https://cp.example', async (url) =>
    url.endsWith('/send')
      ? envelope({ challengeId: 'challenge-1', expiresInSeconds: 600, resendAfterSeconds: 60 })
      : new Promise((resolve) => {
          release = resolve;
        })
  );
  otp.setEmail('first@example.com');
  await otp.send();
  const verifying = otp.verify('123456');
  await Promise.resolve();
  otp.setEmail('second@example.com');
  release(envelope({ otpVerificationToken: 'old.email.proof', expiresInSeconds: 600 }));
  await assert.rejects(verifying, /changed/i);
  assert.equal(otp.token, null);
});

test('registration resume persists only a short-lived session capability and safe route', () => {
  const store = storage();
  saveRegistrationResume(
    {
      registrationId: 'reg-1',
      sessionToken: 'opaque-capability',
      redirectTarget: '/billing?plan=growth&interval=monthly',
      email: 'do-not-save@example.com',
      password: 'do-not-save',
      otpVerificationToken: 'do-not-save',
    },
    store,
    1000
  );
  const saved = readRegistrationResume(store, 1001);
  assert.deepEqual(saved, {
    registrationId: 'reg-1',
    sessionToken: 'opaque-capability',
    redirectTarget: '/billing?plan=growth&interval=monthly',
    createdAt: 1000,
  });
  assert.equal(readRegistrationResume(store, 3601001), null);
});

test('session exchange sends the capability in a header and returns only an authenticated handoff', async () => {
  const result = await exchangeRegistrationSession(
    'https://cp.example/',
    { registrationId: 'reg-1', sessionToken: 'opaque-capability' },
    async (url, init) => {
      assert.equal(url, 'https://cp.example/api/v1/registration/reg-1/session');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer opaque-capability');
      assert.equal(init.body, '{}');
      return envelope({
        token: 'signed.cp.session',
        ssoUrl: 'https://app.markchat.co.ke/app/login?token=abc',
        redirectTarget: '/billing',
        user: { id: 'user-1' },
      });
    }
  );
  assert.equal(result.token, 'signed.cp.session');
  await assert.rejects(
    exchangeRegistrationSession(
      'https://cp.example',
      { registrationId: 'reg-1', sessionToken: 'proof' },
      async () => envelope({ status: 'completed', ssoUrl: 'https://app.markchat.co.ke/app/login' })
    ),
    /session/i
  );
});

test('payment routing uses authoritative outstanding gates, in verification-first order', () => {
  assert.equal(registrationPaymentRequired({ verification: false, subscription: false }), null);
  assert.equal(
    registrationPaymentRequired({ verification: true, subscription: true }),
    'account_verification'
  );
  assert.equal(
    registrationPaymentRequired({ verification: false, subscription: true }),
    'subscription'
  );
  assert.throws(() => registrationPaymentRequired(undefined), /payment/i);
  assert.throws(() => registrationPaymentRequired({ verification: false }), /payment/i);
});

test('registration checkout uses the correct capability endpoint and validates the hosted payment', async () => {
  for (const [purpose, path, amountKesCents] of [
    ['account_verification', 'verification-checkout', 8200],
    ['subscription', 'subscription-checkout', 350000],
  ]) {
    const result = await startRegistrationCheckout(
      'https://cp.example',
      { registrationId: 'reg-1', verificationToken: 'payment-capability' },
      purpose,
      async (url, init) => {
        assert.equal(url, 'https://cp.example/api/v1/registration/reg-1/' + path);
        assert.equal(init.headers.Authorization, 'Bearer payment-capability');
        assert.deepEqual(JSON.parse(init.body), { paymentMethod: 'mpesa' });
        const checkout = {
          reference: 'reference-123',
          authorizationUrl: 'https://checkout.paystack.com/example',
          amountKesCents,
          currency: 'KES',
        };
        return envelope(purpose === 'account_verification' ? { checkout } : checkout);
      }
    );
    assert.equal(result.amountKesCents, amountKesCents);
    assert.equal(result.reference, 'reference-123');
  }
  await assert.rejects(
    startRegistrationCheckout(
      'https://cp.example',
      { registrationId: 'reg-1', verificationToken: 'proof' },
      'subscription',
      async () =>
        envelope({
          reference: 'reference-123',
          authorizationUrl: 'javascript:alert(1)',
          amountKesCents: 350000,
          currency: 'KES',
        })
    ),
    /checkout/i
  );
});

test('an expired setup capability can use only credentials supplied by the current form', async () => {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, body: init.body });
    if (url.endsWith('/session'))
      return new Response(
        JSON.stringify({
          success: false,
          code: 'REGISTRATION_SESSION_INVALID',
          message: 'Registration sign-in has expired or already been used. Sign in to continue.',
        }),
        { status: 401 }
      );
    return envelope({ token: 'authenticated.customer.session', redirectTarget: '/billing' });
  };
  const result = await obtainRegistrationSession(
    'https://cp.example',
    { registrationId: 'reg-1', sessionToken: 'expired-proof' },
    { email: 'person@example.com', password: 'current-form-password' },
    fetcher
  );
  assert.equal(result.token, 'authenticated.customer.session');
  assert.equal(requests[1].url, 'https://cp.example/api/v1/auth/login');
  assert.deepEqual(JSON.parse(requests[1].body), {
    email: 'person@example.com',
    password: 'current-form-password',
  });
  requests.length = 0;
  assert.equal(
    await obtainRegistrationSession(
      'https://cp.example',
      { registrationId: 'reg-1', sessionToken: 'expired-proof' },
      undefined,
      fetcher
    ),
    null
  );
  assert.equal(
    requests.length,
    1,
    'a returned payment page must not invent or recover saved credentials'
  );
});

test('pending session handoff is retried by provisioning instead of attempting a different login', async () => {
  let calls = 0;
  await assert.rejects(
    obtainRegistrationSession(
      'https://cp.example',
      { registrationId: 'reg-1', sessionToken: 'proof' },
      { email: 'person@example.com', password: 'current-form-password' },
      async () => {
        calls++;
        return envelope({}, 409);
      }
    ),
    (error) => error.status === 409
  );
  assert.equal(calls, 1);
});

test('an inactive-account denial is never treated as an expired registration proof', async () => {
  let calls = 0;
  await assert.rejects(
    obtainRegistrationSession(
      'https://cp.example',
      { registrationId: 'reg-1', sessionToken: 'valid-proof' },
      { email: 'person@example.com', password: 'current-form-password' },
      async () => {
        calls++;
        return new Response(
          JSON.stringify({
            success: false,
            code: 'USER_INACTIVE',
            message: 'User account is inactive. Access blocked.',
          }),
          { status: 403 }
        );
      }
    ),
    (error) => error.code === 'USER_INACTIVE'
  );
  assert.equal(calls, 1);
});

test('generic rate limiting honors the JSON retry delay when CORS hides the header', async () => {
  let now = 1000;
  let calls = 0;
  const otp = new EmailVerification(
    'https://cp.example',
    async () => {
      calls++;
      return new Response(
        JSON.stringify({
          success: false,
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please slow down and try again later.',
          retryAfter: '120',
        }),
        { status: 429 }
      );
    },
    () => now
  );
  otp.setEmail('person@example.com');
  await assert.rejects(
    otp.send(),
    (error) => error.code === 'RATE_LIMIT_EXCEEDED' && error.retryAfterSeconds === 120
  );
  assert.equal(otp.resendSeconds, 120);
  now += 61000;
  await assert.rejects(otp.send(), /wait 59 seconds/i);
  assert.equal(calls, 1);
});

test('a server-rejected registration proof can be cleared without bypassing resend cooldown', async () => {
  const otp = new EmailVerification('https://cp.example', async (url) =>
    url.endsWith('/send')
      ? envelope({ challengeId: 'challenge-1', expiresInSeconds: 600, resendAfterSeconds: 60 })
      : envelope({ otpVerificationToken: 'signed.email.proof', expiresInSeconds: 600 })
  );
  otp.setEmail('person@example.com');
  await otp.send();
  await otp.verify('123456');
  otp.invalidateProof();
  assert.equal(otp.token, null);
  assert.equal(otp.hasChallenge, false);
  assert.equal(otp.email, 'person@example.com');
  assert.ok(otp.resendSeconds > 0);
});

test('the signup password validator matches the Control Plane character and length contract', () => {
  for (const password of [
    'onlylowercasepassphrase',
    'OnlylettersPassphrase',
    'LongPassword1234',
    'nouppercase1!',
    'NOLOWERCASE1!',
    'Short1!',
    'Aa1!' + 'x'.repeat(252),
    'Abcd1234🙂',
  ]) {
    assert.ok(registrationPasswordError(password), password);
  }
  for (const password of ['Strong@Password123!', 'Abcd1234?', 'Aa1!' + 'x'.repeat(251)]) {
    assert.equal(registrationPasswordError(password), null);
  }
});
