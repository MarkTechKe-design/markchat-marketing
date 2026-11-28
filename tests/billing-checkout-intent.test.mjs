import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginBillingCheckoutIntent,
  readBillingCheckoutIntent,
  recordBillingCheckoutReference,
  clearBillingCheckoutIntent,
} from '../src/lib/billing-checkout-intent.ts';

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    values,
  };
}
const payload = {
  planId: 'growth',
  paymentMethod: 'mpesa',
  phone: '+254712345678',
  callbackUrl: 'https://markchat.co.ke/billing/return',
  billingCycle: 'annual',
};

test('transport retries reuse a durable idempotency key without storing the phone', async () => {
  const store = storage();
  const first = await beginBillingCheckoutIntent('tenant-1', payload, store);
  const second = await beginBillingCheckoutIntent('tenant-1', payload, store);
  assert.equal(second.key, first.key);
  assert.match(first.key, /^[a-f0-9-]{36}$/);
  assert.equal(readBillingCheckoutIntent('tenant-1', store).key, first.key);
  assert.ok(!JSON.stringify([...store.values.values()]).includes('+254712345678'));
  assert.deepEqual(first.selection, {
    planId: 'growth',
    paymentMethod: 'mpesa',
    billingCycle: 'annual',
  });
});

test('an unresolved checkout cannot silently change amount, method, or phone after a lost response', async () => {
  const store = storage();
  await beginBillingCheckoutIntent('tenant-1', payload, store);
  for (const change of [
    { planId: 'scale' },
    { paymentMethod: 'card' },
    { phone: '+254112345678' },
    { billingCycle: 'monthly' },
  ]) {
    await assert.rejects(
      beginBillingCheckoutIntent('tenant-1', { ...payload, ...change }, store),
      /earlier checkout/i
    );
  }
});

test('only a matching confirmed reference clears the intent, and tenant sessions stay separate', async () => {
  const store = storage();
  const intent = await beginBillingCheckoutIntent('tenant-1', payload, store);
  recordBillingCheckoutReference('tenant-1', 'checkout-reference', store);
  assert.equal(readBillingCheckoutIntent('tenant-2', store), null);
  clearBillingCheckoutIntent('other-reference', store);
  assert.equal(readBillingCheckoutIntent('tenant-1', store).key, intent.key);
  clearBillingCheckoutIntent('checkout-reference', store);
  assert.equal(readBillingCheckoutIntent('tenant-1', store), null);
  const next = await beginBillingCheckoutIntent('tenant-1', payload, store);
  assert.notEqual(next.key, intent.key);
});
