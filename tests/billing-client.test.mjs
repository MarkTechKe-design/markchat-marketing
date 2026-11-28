import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchBillingSubscription,
  fetchWorkspaceDestination,
  prepareWorkspaceLaunch,
  resolveBillingCheckout,
  fetchExistingBillingCheckout,
  BillingRecoveryRequired,
} from '../src/lib/billing-client.ts';
import { persistCustomerSession, readCustomerSession } from '../src/lib/customer-session.ts';

const overview = {
  success: true,
  tenant: {
    id: 'tenant-42',
    name: 'Acme',
    slug: 'acme',
    status: 'active',
    chatwootAccountId: 42,
    provisioningStatus: 'completed',
  },
  subscription: {
    id: 'sub-1',
    planId: 'growth',
    status: 'trial',
    paymentMethod: 'mpesa',
    billingCycle: 'monthly',
    currentPeriodStart: null,
    currentPeriodEnd: '2026-12-01T00:00:00Z',
    gracePeriodEnd: null,
    cancelledAt: null,
    renewalAmountKesCents: 350000,
    currency: 'KES',
  },
  plan: {
    id: 'growth',
    name: 'Growth',
    priceKesCents: 350000,
    priceKes: 3500,
    annualPriceKesCents: 3360000,
    maxAgents: 10,
    maxInboxes: 5,
  },
  entitlements: {
    accessAllowed: true,
    coreSyncStatus: 'synced',
    maxAgents: 10,
    maxInboxes: 5,
    trialInfo: null,
  },
  capabilities: {
    billingCycles: ['monthly', 'annual'],
    annualDiscountPercent: 20,
    canChangePlan: false,
  },
};
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('billing overview sends authenticated account assertion and returns live tenant state', async () => {
  const data = await fetchBillingSubscription(
    'https://cp.example',
    'customer-token',
    '42',
    async (url, init) => {
      assert.equal(url, 'https://cp.example/api/v1/billing/subscription?account_id=42');
      assert.equal(init.headers.Authorization, 'Bearer customer-token');
      assert.equal(init.cache, 'no-store');
      return response(overview);
    }
  );
  assert.equal(data.tenant.name, 'Acme');
  assert.equal(data.subscription.status, 'trial');
  assert.equal(data.capabilities.canChangePlan, false);
});

test('overview never accepts another Core account or an unauthenticated tokenless request', async () => {
  await assert.rejects(
    fetchBillingSubscription('https://cp.example', '', '42', async () =>
      assert.fail('must not fetch')
    ),
    /sign in/i
  );
  await assert.rejects(
    fetchBillingSubscription('https://cp.example', 'customer-token', '99', async () =>
      response(overview)
    ),
    /account/i
  );
  await assert.rejects(
    fetchBillingSubscription('https://cp.example', 'customer-token', '42', async () =>
      response({ ...overview, tenant: undefined })
    ),
    /verified/i
  );
});

test('billing authorization failures preserve status for login and approval routing', async () => {
  for (const status of [401, 403]) {
    await assert.rejects(
      fetchBillingSubscription('https://cp.example', 'customer-token', null, async () =>
        response({ success: false, message: 'Access denied' }, status)
      ),
      (error) => error.status === status
    );
  }
});

test('workspace launch uses authenticated SSO and validates its destination', async () => {
  const result = await fetchWorkspaceDestination(
    'https://cp.example',
    'customer-token',
    async (url, init) => {
      assert.equal(url, 'https://cp.example/api/v1/auth/sso');
      assert.equal(init.method, 'POST');
      assert.equal(init.body, '{}');
      assert.equal(init.headers.Authorization, 'Bearer customer-token');
      return response({
        success: true,
        url: 'https://app.markchat.co.ke/app/login?token=verified',
      });
    }
  );
  assert.equal(result, 'https://app.markchat.co.ke/app/login?token=verified');
  for (const url of [
    '/',
    'https://evil.example/app/login',
    'https://app.markchat.co.ke/admin',
    'javascript:alert(1)',
  ]) {
    await assert.rejects(
      fetchWorkspaceDestination('https://cp.example', 'customer-token', async () =>
        response({ success: true, url })
      ),
      /destination/i
    );
  }
});

test('a verified launch stays bound to its receipt identity after browser customer storage switches accounts', async () => {
  const values = new Map();
  const session = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  persistCustomerSession('receipt-owner-token', { session });
  let calls = 0;
  const prepared = await prepareWorkspaceLaunch(
    'https://cp.example',
    readCustomerSession({ session }),
    async (url, init) => {
      calls++;
      assert.equal(url, 'https://cp.example/api/v1/auth/sso');
      assert.equal(init.headers.Authorization, 'Bearer receipt-owner-token');
      return response({ url: 'https://app.markchat.co.ke/app/login?token=receipt-owner-' + calls });
    }
  );
  persistCustomerSession('different-workspace-token', { session });
  assert.equal(readCustomerSession({ session }), 'different-workspace-token');
  assert.equal(
    await prepared.launch(),
    'https://app.markchat.co.ke/app/login?token=receipt-owner-2'
  );
  assert.equal(calls, 2, 'The click refreshes SSO with the original verified identity');
});

test('an existing received payment needing reconciliation routes to its receipt without initiating another charge', async () => {
  let newCharges = 0;
  const existing = {
    reference: 'received-reference',
    amountKesCents: 3360000,
    currency: 'KES',
    planId: 'growth',
    billingCycle: 'annual',
    paymentMethod: 'card',
    status: 'success',
    requiresReconciliation: true,
    reconciliationReason: 'subscription_changed',
    authorizationUrl: null,
  };
  const result = await resolveBillingCheckout(existing, async () => {
    newCharges++;
    return {
      reference: 'new-charge-reference',
      amountKesCents: 3360000,
      currency: 'KES',
      authorizationUrl: 'https://checkout.paystack.com/new-charge',
    };
  });
  assert.deepEqual(result, {
    reference: 'received-reference',
    url: '/billing/return?reference=received-reference',
  });
  assert.equal(newCharges, 0);
});

test('checkout initialization runs once only when there is no existing payment', async () => {
  let newCharges = 0;
  const result = await resolveBillingCheckout(null, async () => {
    newCharges++;
    return {
      reference: 'new-charge-reference',
      amountKesCents: 350000,
      currency: 'KES',
      authorizationUrl: 'https://checkout.paystack.com/new-charge',
    };
  });
  assert.equal(newCharges, 1);
  assert.deepEqual(result, {
    reference: 'new-charge-reference',
    url: 'https://checkout.paystack.com/new-charge',
  });
});

test('a legacy monthly service still permits initial checkout when pending discovery is unavailable', async () => {
  const existing = await fetchExistingBillingCheckout(
    'https://cp.example',
    'customer-token',
    { allowLegacyMonthly: true },
    async () => response({ success: false }, 404)
  );
  let initializers = 0;
  await resolveBillingCheckout(existing, async () => {
    initializers++;
    return {
      reference: 'first-reference',
      amountKesCents: 150000,
      currency: 'KES',
      authorizationUrl: 'https://checkout.paystack.com/first',
    };
  });
  assert.equal(existing, null);
  assert.equal(initializers, 1);
});

test('an unresolved intent on a legacy service stops before any second initializer and retains receipt recovery', async () => {
  let initializers = 0;
  for (const reference of [null, 'saved-reference']) {
    await assert.rejects(
      async () => {
        const existing = await fetchExistingBillingCheckout(
          'https://cp.example',
          'customer-token',
          { allowLegacyMonthly: true, intent: { key: 'existing-request-key', reference } },
          async (url, init) => {
            assert.equal(url, 'https://cp.example/api/v1/billing/checkout/pending');
            assert.equal(init.headers['Idempotency-Key'], 'existing-request-key');
            assert.notEqual(init.method, 'POST');
            return response({ success: false }, 404);
          }
        );
        await resolveBillingCheckout(existing, async () => {
          initializers++;
          throw new Error('Must not create another charge');
        });
      },
      (error) =>
        error instanceof BillingRecoveryRequired &&
        error.reference === reference &&
        /support|receipt/i.test(error.message)
    );
  }
  assert.equal(initializers, 0);
});
