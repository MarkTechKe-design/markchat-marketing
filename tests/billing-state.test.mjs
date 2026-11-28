import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBillingCatalog,
  billingQuote,
  supportsAnnualBilling,
  normalizeKenyanPhone,
  billingCheckoutPayload,
  validateBillingCheckout,
  parsePendingBillingCheckout,
  subscriptionSettlement,
  registrationSettlement,
  billingLoginDestination,
  trialBillingNote,
  formatKes,
} from '../src/lib/billing-state.ts';

const plans = [
  {
    id: 'starter',
    name: 'Starter',
    priceKesCents: 150000,
    priceKes: 1500,
    annualPriceKesCents: 1440000,
    maxAgents: 3,
    maxInboxes: 2,
  },
  {
    id: 'growth',
    name: 'Growth',
    priceKesCents: 350000,
    priceKes: 3500,
    annualPriceKesCents: 3360000,
    maxAgents: 10,
    maxInboxes: 5,
  },
  {
    id: 'scale',
    name: 'Scale',
    priceKesCents: 500000,
    priceKes: 5000,
    annualPriceKesCents: 4800000,
    maxAgents: 25,
    maxInboxes: null,
  },
];
const capabilities = { billingCycles: ['monthly', 'annual'], annualDiscountPercent: 20 };
const liveCatalog = () => parseBillingCatalog({ success: true, plans, ...capabilities });

test('checkout amounts explicitly identify Kenyan shillings and retain cents when present', () => {
  assert.equal(formatKes(150000).replace(/\s/g, ' '), 'KES 1,500');
  assert.equal(formatKes(150025).replace(/\s/g, ' '), 'KES 1,500.25');
});

test('annual quotes charge twelve discounted months and retain actual seat and inbox limits', () => {
  const catalog = liveCatalog();
  for (const [id, amount, monthly] of [
    ['starter', 1440000, 120000],
    ['growth', 3360000, 280000],
    ['scale', 4800000, 400000],
  ]) {
    const quote = billingQuote(catalog, id, 'annual', capabilities);
    assert.equal(quote.amountKesCents, amount);
    assert.equal(quote.monthlyEquivalentKesCents, monthly);
    assert.equal(quote.billingCycle, 'annual');
  }
  const scale = billingQuote(catalog, 'scale', 'monthly', capabilities);
  assert.equal(scale.amountKesCents, 500000);
  assert.equal(scale.maxAgents, 25);
  assert.equal(scale.maxInboxes, null);
});

test('a monthly-only or incomplete API cannot create an annual quote', () => {
  const legacy = parseBillingCatalog({
    plans: plans.map((plan) => ({ ...plan, annualPriceKesCents: undefined })),
  });
  assert.equal(supportsAnnualBilling(legacy, capabilities), false);
  assert.throws(() => billingQuote(legacy, 'growth', 'annual', capabilities), /annual/i);
  assert.equal(billingQuote(legacy, 'growth', 'monthly').amountKesCents, 350000);
  assert.equal(supportsAnnualBilling(liveCatalog(), undefined), false);
  assert.equal(supportsAnnualBilling(liveCatalog(), { billingCycles: ['monthly'] }), false);
  const wrongAnnual = parseBillingCatalog({
    plans: plans.map((plan) => ({ ...plan, annualPriceKesCents: 1 })),
    ...capabilities,
  });
  assert.equal(supportsAnnualBilling(wrongAnnual, capabilities), false);
});

test('catalog rejects absent, duplicate, unsafe, or nonpositive monthly prices', () => {
  for (const value of [
    {},
    { plans: [] },
    { plans: [...plans, plans[0]] },
    { plans: plans.map((plan) => ({ ...plan, priceKesCents: 0 })) },
    { plans: plans.map((plan) => ({ ...plan, priceKesCents: Number.MAX_SAFE_INTEGER + 1 })) },
  ])
    assert.throws(() => parseBillingCatalog(value), /pricing/i);
});

test('Kenyan local and international mobile numbers normalize without accepting extensions or other countries', () => {
  for (const [input, expected] of [
    ['0712 345 678', '+254712345678'],
    ['0112345678', '+254112345678'],
    ['254712345678', '+254712345678'],
    ['+254 (712) 345-678', '+254712345678'],
  ])
    assert.equal(normalizeKenyanPhone(input), expected);
  for (const input of [
    '',
    '+255712345678',
    '071234567',
    '07123456789',
    '++254712345678',
    '0712345678x2',
    '+254712345678\n',
  ]) {
    assert.equal(normalizeKenyanPhone(input), null, input);
  }
});

test('card skips phone entirely while M-Pesa requires normalized phone and never sends client amounts', () => {
  const quote = billingQuote(liveCatalog(), 'growth', 'annual', capabilities);
  const base = { quote, callbackUrl: 'https://markchat.co.ke/billing/return', accountId: '42' };
  assert.deepEqual(
    billingCheckoutPayload({ ...base, paymentMethod: 'card', phone: 'not a phone' }),
    {
      planId: 'growth',
      billingCycle: 'annual',
      paymentMethod: 'card',
      callbackUrl: 'https://markchat.co.ke/billing/return',
      account_id: '42',
    }
  );
  assert.deepEqual(
    billingCheckoutPayload({ ...base, paymentMethod: 'mpesa', phone: '0712345678' }),
    {
      planId: 'growth',
      billingCycle: 'annual',
      paymentMethod: 'mpesa',
      phone: '+254712345678',
      callbackUrl: 'https://markchat.co.ke/billing/return',
      account_id: '42',
    }
  );
  assert.throws(
    () => billingCheckoutPayload({ ...base, paymentMethod: 'mpesa', phone: '1234' }),
    /phone/i
  );
  const monthly = billingQuote(liveCatalog(), 'starter', 'monthly');
  assert.equal(
    'billingCycle' in billingCheckoutPayload({ ...base, quote: monthly, paymentMethod: 'card' }),
    false
  );
});

test('checkout requires a matching server quote and a Paystack destination, while an ambiguous payment stays pending', () => {
  const quote = billingQuote(liveCatalog(), 'growth', 'annual', capabilities);
  const response = {
    reference: 'checkout-reference',
    amountKesCents: 3360000,
    currency: 'KES',
    planId: 'growth',
    billingCycle: 'annual',
    status: 'pending',
    retryAllowed: false,
    requiresReconciliation: false,
    authorizationUrl: 'https://checkout.paystack.com/example',
  };
  assert.equal(
    validateBillingCheckout(response, quote).authorizationUrl,
    response.authorizationUrl
  );
  assert.equal(
    validateBillingCheckout(
      { ...response, authorizationUrl: null, requiresReconciliation: true },
      quote
    ).authorizationUrl,
    null
  );
  for (const change of [
    { amountKesCents: 350000 },
    { currency: 'USD' },
    { billingCycle: 'monthly' },
    { planId: 'scale' },
    { authorizationUrl: 'https://evil.example/' },
    { authorizationUrl: null, requiresReconciliation: false },
  ])
    assert.throws(() => validateBillingCheckout({ ...response, ...change }, quote), /checkout/i);
});

test('a settled idempotent checkout replay routes to its receipt without another payment destination', () => {
  const quote = billingQuote(liveCatalog(), 'growth', 'annual', capabilities);
  assert.equal(
    validateBillingCheckout(
      {
        reference: 'checkout-reference',
        amountKesCents: 3360000,
        currency: 'KES',
        planId: 'growth',
        billingCycle: 'annual',
        status: 'success',
        retryAllowed: false,
        requiresReconciliation: false,
        authorizationUrl: null,
      },
      quote
    ).authorizationUrl,
    null
  );
});

test('legacy monthly checkout responses remain valid without additive reconciliation fields', () => {
  const quote = billingQuote(liveCatalog(), 'starter', 'monthly');
  const checkout = validateBillingCheckout(
    {
      reference: 'legacy-reference',
      amountKesCents: 150000,
      currency: 'KES',
      authorizationUrl: 'https://checkout.paystack.com/legacy',
    },
    quote
  );
  assert.equal(checkout.reference, 'legacy-reference');
  assert.equal(checkout.authorizationUrl, 'https://checkout.paystack.com/legacy');
});

test('pending discovery accepts only an existing subscription attempt with validated payment details', () => {
  const data = {
    reference: 'checkout-reference',
    amountKesCents: 3360000,
    currency: 'KES',
    planId: 'growth',
    billingCycle: 'annual',
    paymentMethod: 'card',
    purpose: 'subscription',
    status: 'pending',
    retryAllowed: false,
    requiresReconciliation: false,
    authorizationUrl: 'https://checkout.paystack.com/original',
  };
  assert.equal(parsePendingBillingCheckout(null), null);
  assert.equal(parsePendingBillingCheckout(data).reference, 'checkout-reference');
  assert.equal(
    parsePendingBillingCheckout({ ...data, status: 'success', authorizationUrl: null }).status,
    'success'
  );
  for (const change of [
    { purpose: 'sms_bundle' },
    { authorizationUrl: 'https://evil.example/' },
    { billingCycle: 'weekly' },
    { amountKesCents: -1 },
    { planId: 'custom' },
  ]) {
    assert.throws(() => parsePendingBillingCheckout({ ...data, ...change }), /existing payment/i);
  }
});

const receipt = {
  reference: 'checkout-reference',
  status: 'success',
  purpose: 'subscription',
  amountKesCents: 3360000,
  currency: 'KES',
  paymentConfirmed: true,
  entitlementsSynced: true,
  entitlements: { accessAllowed: true, coreSyncStatus: 'synced' },
};

test('settlement keeps payment, entitlement synchronization, and safe workspace launch separate', () => {
  const awaiting = subscriptionSettlement(
    { ...receipt, status: 'pending', paymentConfirmed: false },
    receipt.reference
  );
  assert.deepEqual(
    [awaiting.paymentVerified, awaiting.entitlementsSynced, awaiting.workspaceReady],
    [false, false, false]
  );
  const syncing = subscriptionSettlement(
    {
      ...receipt,
      entitlementsSynced: false,
      entitlements: { accessAllowed: true, coreSyncStatus: 'pending' },
    },
    receipt.reference
  );
  assert.deepEqual(
    [syncing.paymentVerified, syncing.entitlementsSynced, syncing.workspaceReady],
    [true, false, false]
  );
  const paid = subscriptionSettlement(receipt, receipt.reference);
  assert.deepEqual(
    [paid.paymentVerified, paid.entitlementsSynced, paid.workspaceReady],
    [true, true, false]
  );
  assert.equal(
    subscriptionSettlement(receipt, receipt.reference, 'https://evil.example/app/login')
      .workspaceReady,
    false
  );
  const ready = subscriptionSettlement(
    receipt,
    receipt.reference,
    'https://app.markchat.co.ke/app/login?token=verified'
  );
  assert.equal(ready.workspaceReady, true);
  assert.equal(ready.launchUrl, 'https://app.markchat.co.ke/app/login?token=verified');
});

test('a received but unapplied payment cannot launch even when the tenant already has synchronized access', () => {
  const progress = subscriptionSettlement(
    { ...receipt, requiresReconciliation: true, reconciliationReason: 'subscription_changed' },
    receipt.reference,
    'https://app.markchat.co.ke/app/login?token=otherwise-valid'
  );
  assert.equal(progress.paymentVerified, true);
  assert.equal(progress.requiresReconciliation, true);
  assert.equal(progress.reconciliationReason, 'subscription_changed');
  assert.equal(progress.entitlementsSynced, false);
  assert.equal(progress.workspaceReady, false);
  assert.equal(progress.launchUrl, null);
  assert.equal(progress.failed, false);
});

test('checkout replay and existing-attempt discovery preserve received payments that need reconciliation', () => {
  const data = {
    reference: 'checkout-reference',
    amountKesCents: 3360000,
    currency: 'KES',
    planId: 'growth',
    billingCycle: 'annual',
    paymentMethod: 'card',
    purpose: 'subscription',
    status: 'success',
    paymentConfirmed: true,
    retryAllowed: false,
    requiresReconciliation: true,
    reconciliationReason: 'subscription_changed',
    authorizationUrl: null,
  };
  const checkout = validateBillingCheckout(
    data,
    billingQuote(liveCatalog(), 'growth', 'annual', capabilities)
  );
  assert.equal(checkout.authorizationUrl, null);
  const existing = parsePendingBillingCheckout(data);
  assert.equal(existing.status, 'success');
  assert.equal(existing.requiresReconciliation, true);
  assert.equal(existing.reconciliationReason, 'subscription_changed');
  assert.equal(existing.authorizationUrl, null);
  assert.throws(
    () =>
      validateBillingCheckout(
        { ...data, authorizationUrl: 'https://checkout.paystack.com/another-charge' },
        billingQuote(liveCatalog(), 'growth', 'annual', capabilities)
      ),
    /checkout/i
  );
  assert.throws(
    () =>
      parsePendingBillingCheckout({
        ...data,
        authorizationUrl: 'https://checkout.paystack.com/another-charge',
      }),
    /existing payment/i
  );
  assert.equal(
    subscriptionSettlement(receipt, receipt.reference).requiresReconciliation,
    false,
    'Legacy receipts without the additive field keep their verified behavior'
  );
});

test('anonymous receipts, stale success flags, wrong references, and other payment purposes cannot unlock the tracker', () => {
  assert.equal(
    subscriptionSettlement(
      { ...receipt, paymentConfirmed: undefined, entitlementsSynced: undefined },
      receipt.reference
    ).paymentVerified,
    false
  );
  assert.equal(
    subscriptionSettlement(
      { ...receipt, entitlements: { accessAllowed: false, coreSyncStatus: 'synced' } },
      receipt.reference
    ).entitlementsSynced,
    false
  );
  for (const change of [
    { reference: 'different-reference' },
    { purpose: 'account_verification' },
    { amountKesCents: -1 },
  ]) {
    assert.throws(
      () => subscriptionSettlement({ ...receipt, ...change }, receipt.reference),
      /receipt/i
    );
  }
});

test('a completed registration reload must match the authenticated workspace and current payment gates', () => {
  const status = {
    status: 'completed',
    tenantId: 'tenant-1',
    paymentRequirements: { verification: false, subscription: false },
  };
  const overview = {
    tenant: { id: 'tenant-1' },
    entitlements: { accessAllowed: true, coreSyncStatus: 'synced' },
  };
  assert.deepEqual(registrationSettlement(status, overview), {
    paymentVerified: true,
    entitlementsSynced: true,
  });
  assert.deepEqual(
    registrationSettlement(status, {
      ...overview,
      entitlements: { accessAllowed: true, coreSyncStatus: 'pending' },
    }),
    { paymentVerified: true, entitlementsSynced: false }
  );
  for (const change of [
    { tenantId: 'tenant-2' },
    { status: 'processing' },
    { paymentRequirements: { verification: true, subscription: false } },
    { paymentRequirements: undefined },
  ]) {
    assert.throws(
      () => registrationSettlement({ ...status, ...change }, overview),
      /workspace setup/i
    );
  }
});

test('sign-in preserves billing intent and receipt query without allowing external redirects', () => {
  assert.equal(
    billingLoginDestination('/billing?plan=scale&interval=annual&account_id=42'),
    '/login?redirect=%2Fbilling%3Fplan%3Dscale%26interval%3Dannual%26account_id%3D42'
  );
  assert.equal(
    billingLoginDestination('/billing/return?reference=checkout-reference'),
    '/login?redirect=%2Fbilling%2Freturn%3Freference%3Dcheckout-reference'
  );
  assert.equal(billingLoginDestination('//evil.example/'), '/login?redirect=%2Fbilling');
});

test('trial note comes from live policy and never promises a fixed trial or deferred charge', () => {
  const note = trialBillingNote({
    isTrial: true,
    trialEnd: '2026-12-01T10:00:00.000Z',
    isExpired: false,
    hoursRemaining: 18,
    durationHours: 72,
    durationLabel: '3 days',
  });
  assert.match(note, /18 hours/);
  assert.match(note, /charged now/i);
  assert.match(trialBillingNote({ isTrial: true, isExpired: true, hoursRemaining: 0 }), /ended/i);
  assert.match(trialBillingNote(null), /confirmed payment/i);
});
