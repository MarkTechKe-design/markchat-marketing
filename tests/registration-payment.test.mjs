import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRegistrationPaymentProgress,
  prepareRegistrationPayment,
  recoverRegistrationPaymentReference,
} from '../src/lib/registration-payment.ts';
import {
  readPendingRegistrationPayment,
  savePendingRegistrationPayment,
  startRegistrationCheckout,
} from '../src/lib/registration-client.ts';

const apiUrl = 'https://cp.example';
const registration = { registrationId: 'reg-1', verificationToken: 'payment-capability' };
const purpose = 'subscription';
const envelope = (data) => new Response(JSON.stringify({ success: true, data }));
const storage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
};
const payment = (status = 'pending', extra = {}) => ({
  reference: 'reference-original',
  status,
  purpose,
  amountKesCents: 350000,
  currency: 'KES',
  retryAllowed: ['failed', 'abandoned'].includes(status),
  authorizationUrl: status === 'pending' ? 'https://checkout.paystack.com/original' : null,
  requiresReconciliation: false,
  ...extra,
});
function savePayment(store, value = payment()) {
  savePendingRegistrationPayment({ registrationId: registration.registrationId, ...value }, store);
}
const checkout = {
  reference: 'reference-new-checkout',
  authorizationUrl: 'https://checkout.paystack.com/new-checkout',
  amountKesCents: 350000,
  currency: 'KES',
};

test('payment lookup authenticates the exact saved registration and reference', async () => {
  const store = storage();
  savePayment(store);
  const progress = await getRegistrationPaymentProgress(apiUrl, registration, purpose, {
    storage: store,
    fetcher: async (url, init) => {
      assert.equal(url, apiUrl + '/api/v1/registration/reg-1/payments/reference-original');
      assert.equal(init.headers.Authorization, 'Bearer payment-capability');
      assert.equal(init.cache, 'no-store');
      assert.equal(init.method, undefined);
      return envelope(payment());
    },
  });
  assert.equal(progress.kind, 'checkout');
  assert.equal(progress.checkout.authorizationUrl, payment().authorizationUrl);
});

test('saved payment scope and server retry semantics are validated before any action', async () => {
  for (const change of [
    { reference: 'reference-other' },
    { purpose: 'account_verification' },
    { amountKesCents: 8200 },
    { currency: 'USD' },
    { retryAllowed: true },
    { status: 'unverified' },
    { authorizationUrl: 'https://attacker.example/checkout' },
    { requiresReconciliation: true },
  ]) {
    const store = storage();
    savePayment(store);
    await assert.rejects(
      prepareRegistrationPayment(apiUrl, registration, purpose, {
        storage: store,
        allowRetry: true,
        fetcher: async (url, init) => {
          assert.notEqual(init.method, 'POST');
          return envelope(payment('pending', change));
        },
      }),
      /payment|checkout/i
    );
    assert.equal(readPendingRegistrationPayment(store).reference, 'reference-original');
  }
});

test('discovery distinguishes an authoritative missing attempt from a malformed response', async () => {
  const store = storage();
  assert.equal(
    (
      await getRegistrationPaymentProgress(apiUrl, registration, purpose, {
        storage: store,
        fetcher: async (url, init) => {
          assert.equal(url, apiUrl + '/api/v1/registration/reg-1/payments?purpose=subscription');
          assert.equal(init.headers.Authorization, 'Bearer payment-capability');
          return envelope(null);
        },
      })
    ).kind,
    'none'
  );
  await assert.rejects(
    prepareRegistrationPayment(apiUrl, registration, purpose, {
      storage: store,
      fetcher: async (url, init) => {
        assert.notEqual(init.method, 'POST');
        return envelope({});
      },
    }),
    /payment/i
  );
});

test('confirmed failed or abandoned attempts require explicit retry and preserve registration proof', async () => {
  for (const status of ['failed', 'abandoned']) {
    const store = storage();
    store.setItem('markchat_reg_idempotency_key', 'original-idempotency-key');
    store.setItem('markchat_registration_session', 'original-registration-capability');
    savePayment(store);
    let posts = 0;
    const fetcher = async (url, init) => {
      if (init.method === 'POST') {
        posts++;
        assert.equal(url, apiUrl + '/api/v1/registration/reg-1/subscription-checkout');
        return new Response(JSON.stringify({ success: true, checkout }));
      }
      return envelope(payment(status));
    };
    const held = await prepareRegistrationPayment(apiUrl, registration, purpose, {
      storage: store,
      fetcher,
    });
    assert.equal(held.kind, 'retry');
    assert.equal(posts, 0);
    assert.equal(readPendingRegistrationPayment(store).reference, 'reference-original');
    const retried = await prepareRegistrationPayment(apiUrl, registration, purpose, {
      storage: store,
      fetcher,
      allowRetry: true,
    });
    assert.equal(retried.kind, 'checkout');
    assert.equal(posts, 1);
    assert.equal(readPendingRegistrationPayment(store).reference, checkout.reference);
    assert.equal(store.getItem('markchat_reg_idempotency_key'), 'original-idempotency-key');
    assert.equal(
      store.getItem('markchat_registration_session'),
      'original-registration-capability'
    );
  }
});

test('pending hosted checkouts are resumed without initializing another charge', async () => {
  const store = storage();
  savePayment(store);
  const result = await prepareRegistrationPayment(apiUrl, registration, purpose, {
    storage: store,
    allowRetry: true,
    fetcher: async (url, init) => {
      assert.notEqual(init.method, 'POST');
      return envelope(payment());
    },
  });
  assert.equal(result.kind, 'checkout');
  assert.equal(result.checkout.reference, 'reference-original');
});

test('pending attempts without a hosted URL and successful payments never create another charge', async () => {
  for (const current of [
    payment('pending', { authorizationUrl: null, requiresReconciliation: true }),
    payment('success'),
  ]) {
    const store = storage();
    savePayment(store);
    const result = await prepareRegistrationPayment(apiUrl, registration, purpose, {
      storage: store,
      allowRetry: true,
      fetcher: async (url, init) => {
        assert.notEqual(init.method, 'POST');
        return envelope(current);
      },
    });
    assert.equal(result.kind, 'waiting');
    assert.match(result.message, /confirm|processing|support/i);
    assert.equal(readPendingRegistrationPayment(store).reference, 'reference-original');
  }
});

test('received registration payments needing reconciliation preserve proof and never initialize or promise activation', async () => {
  const store = storage();
  savePayment(store);
  const requests = [];
  const result = await prepareRegistrationPayment(apiUrl, registration, purpose, {
    storage: store,
    allowRetry: true,
    fetcher: async (url, init) => {
      requests.push({ url, method: init.method });
      assert.notEqual(init.method, 'POST');
      return envelope(
        payment('success', {
          requiresReconciliation: true,
          reconciliationReason: 'subscription_changed',
        })
      );
    },
  });
  assert.equal(result.kind, 'waiting');
  assert.equal(result.payment.status, 'success');
  assert.equal(result.payment.requiresReconciliation, true);
  assert.equal(result.payment.reconciliationReason, 'subscription_changed');
  assert.equal(result.payment.retryAllowed, false);
  assert.equal(result.payment.authorizationUrl, null);
  assert.match(result.message, /received.*support.*reconcil/i);
  assert.doesNotMatch(result.message, /activation is still processing|awaiting confirmation/i);
  assert.equal(readPendingRegistrationPayment(store).reference, 'reference-original');
  assert.equal(requests.length, 1);
});

test('discovery recovers an initialization response lost before the browser saved its reference', async () => {
  const store = storage();
  const result = await prepareRegistrationPayment(apiUrl, registration, 'account_verification', {
    storage: store,
    fetcher: async (url, init) => {
      assert.equal(
        url,
        apiUrl + '/api/v1/registration/reg-1/payments?purpose=account_verification'
      );
      assert.notEqual(init.method, 'POST');
      return envelope(
        payment('pending', { purpose: 'account_verification', amountKesCents: 8200 })
      );
    },
  });
  assert.equal(result.kind, 'checkout');
  assert.equal(readPendingRegistrationPayment(store).purpose, 'account_verification');
  assert.equal(readPendingRegistrationPayment(store).amountKesCents, 8200);
});

test('a lost verification reference is recovered before advancing to the separate subscription gate', async () => {
  const store = storage();
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, method: init.method });
    assert.equal(init.headers.Authorization, 'Bearer payment-capability');
    if (url.endsWith('/payments/verification-reference'))
      return envelope(
        payment('success', {
          reference: 'verification-reference',
          purpose: 'account_verification',
          amountKesCents: 8200,
        })
      );
    if (url.endsWith('/payments?purpose=subscription')) return envelope(null);
    assert.equal(url, apiUrl + '/api/v1/registration/reg-1/subscription-checkout');
    assert.equal(init.method, 'POST');
    return new Response(JSON.stringify({ success: true, checkout }));
  };
  await recoverRegistrationPaymentReference(apiUrl, registration, 'verification-reference', {
    storage: store,
    fetcher,
  });
  assert.equal(readPendingRegistrationPayment(store).purpose, 'account_verification');
  const result = await prepareRegistrationPayment(apiUrl, registration, 'subscription', {
    storage: store,
    fetcher,
  });
  assert.equal(result.kind, 'checkout');
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
  assert.equal(readPendingRegistrationPayment(store).purpose, 'subscription');
});

test('return-reference recovery rejects mismatched or unscoped payment evidence', async () => {
  for (const change of [
    { reference: 'other-reference' },
    { purpose: 'wallet' },
    { currency: 'USD' },
  ]) {
    const store = storage();
    await assert.rejects(
      recoverRegistrationPaymentReference(apiUrl, registration, 'reference-original', {
        storage: store,
        fetcher: async (url, init) => {
          assert.notEqual(init.method, 'POST');
          return envelope(payment('success', change));
        },
      }),
      /payment/i
    );
    assert.equal(readPendingRegistrationPayment(store), null);
  }
});

test('a lost initialization response prevents automatic repost and allows an explicit connection retry', async () => {
  const store = storage();
  let posts = 0;
  const fetcher = async (url, init) => {
    if (init.method === 'POST') {
      posts++;
      if (posts === 1) throw new Error('Connection lost');
      return new Response(JSON.stringify({ success: true, checkout }));
    }
    return envelope(null);
  };
  await assert.rejects(
    prepareRegistrationPayment(apiUrl, registration, purpose, { storage: store, fetcher }),
    /Connection lost/
  );
  assert.equal(posts, 1);
  const held = await prepareRegistrationPayment(apiUrl, registration, purpose, {
    storage: store,
    fetcher,
  });
  assert.equal(held.kind, 'connection_retry');
  assert.equal(posts, 1);
  const retried = await prepareRegistrationPayment(apiUrl, registration, purpose, {
    storage: store,
    fetcher,
    allowRetry: true,
  });
  assert.equal(retried.kind, 'checkout');
  assert.equal(posts, 2);
});

test('an uncertain retry discovers a newer active attempt instead of reposting against an old failure', async () => {
  const store = storage();
  savePayment(store);
  let calls = 0;
  const result = await prepareRegistrationPayment(apiUrl, registration, purpose, {
    storage: store,
    allowRetry: true,
    fetcher: async (url, init) => {
      calls++;
      assert.notEqual(init.method, 'POST');
      return envelope(
        url.endsWith('/reference-original')
          ? payment('failed')
          : payment('pending', { reference: 'reference-newer-pending' })
      );
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.kind, 'checkout');
  assert.equal(result.checkout.reference, 'reference-newer-pending');
  assert.equal(readPendingRegistrationPayment(store).reference, 'reference-newer-pending');
});

test('a lost failed-payment retry can reconnect explicitly when discovery still reports only that failure', async () => {
  const store = storage();
  savePayment(store);
  let posts = 0;
  const fetcher = async (url, init) => {
    if (init.method === 'POST') {
      posts++;
      if (posts === 1) throw new Error('Connection lost');
      return new Response(JSON.stringify({ success: true, checkout }));
    }
    return envelope(payment('failed'));
  };
  await assert.rejects(
    prepareRegistrationPayment(apiUrl, registration, purpose, {
      storage: store,
      fetcher,
      allowRetry: true,
    }),
    /Connection lost/
  );
  assert.equal(posts, 1);
  const held = await prepareRegistrationPayment(apiUrl, registration, purpose, {
    storage: store,
    fetcher,
  });
  assert.equal(held.kind, 'connection_retry');
  assert.equal(posts, 1);
  const retry = await prepareRegistrationPayment(apiUrl, registration, purpose, {
    storage: store,
    fetcher,
    allowRetry: true,
  });
  assert.equal(retry.kind, 'checkout');
  assert.equal(posts, 2);
});

test('a stored payment from another registration never supplies the lookup identity or capability', async () => {
  const store = storage();
  savePendingRegistrationPayment({ registrationId: 'other-registration', ...payment() }, store);
  const result = await prepareRegistrationPayment(apiUrl, registration, purpose, {
    storage: store,
    fetcher: async (url, init) => {
      assert.equal(url, apiUrl + '/api/v1/registration/reg-1/payments?purpose=subscription');
      assert.equal(init.headers.Authorization, 'Bearer payment-capability');
      assert.notEqual(init.method, 'POST');
      return envelope(payment('pending', { reference: 'current-registration-reference' }));
    },
  });
  assert.equal(result.kind, 'checkout');
  assert.equal(readPendingRegistrationPayment(store).registrationId, 'reg-1');
  assert.equal(readPendingRegistrationPayment(store).reference, 'current-registration-reference');
});

test('lookup errors never clear a saved payment or authorize another checkout', async () => {
  for (const status of [401, 404, 429, 500]) {
    const store = storage();
    savePayment(store);
    await assert.rejects(
      prepareRegistrationPayment(apiUrl, registration, purpose, {
        storage: store,
        allowRetry: true,
        fetcher: async (url, init) => {
          assert.notEqual(init.method, 'POST');
          return new Response(JSON.stringify({ success: false, message: 'Lookup unavailable' }), {
            status,
          });
        },
      }),
      /Lookup unavailable/
    );
    assert.equal(readPendingRegistrationPayment(store).reference, 'reference-original');
  }
});

test('checkout initialization is blocked if its recovery intent cannot be persisted', async () => {
  const store = storage();
  store.setItem = () => {
    throw new Error('Storage disabled');
  };
  await assert.rejects(
    prepareRegistrationPayment(apiUrl, registration, purpose, {
      storage: store,
      fetcher: async (url, init) => {
        assert.notEqual(init.method, 'POST');
        return envelope(null);
      },
    }),
    /storage/i
  );
});

test('initialization and recovery accept only canonical Paystack hosted checkout URLs', async () => {
  for (const authorizationUrl of [
    'https://attacker.example/checkout',
    'https://checkout.paystack.com.attacker.example/checkout',
    'https://checkout.paystack.com:444/checkout',
    'https://user@checkout.paystack.com/checkout',
    'https://checkout.paystack.com/checkout#fragment',
    'https://checkout.paystack.com/checkout#',
    'https://checkout.paystack.com/',
    'https://checkout.paystack.com/\\checkout',
    'https://checkout.paystack.com/checkout\n',
  ]) {
    await assert.rejects(
      startRegistrationCheckout(apiUrl, registration, purpose, async () =>
        envelope({ ...checkout, authorizationUrl })
      ),
      /checkout/i
    );
  }
});
