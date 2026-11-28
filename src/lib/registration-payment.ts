import type { CustomerStorage } from './customer-session.ts';
import {
  RegistrationError,
  clearPendingRegistrationPayment,
  readPendingRegistrationPayment,
  registrationCheckoutUrl,
  registrationRequest,
  savePendingRegistrationPayment,
  startRegistrationCheckout,
  type PendingRegistrationPayment,
  type RegistrationCheckout,
  type RegistrationPaymentPurpose,
} from './registration-client.ts';

type Registration = { registrationId: string; verificationToken?: string };
type PaymentOptions = { storage?: CustomerStorage; fetcher?: typeof fetch; allowRetry?: boolean };
type Payment = {
  reference: string;
  status: 'pending' | 'success' | 'failed' | 'abandoned';
  purpose: RegistrationPaymentPurpose;
  amountKesCents: number;
  currency: 'KES';
  retryAllowed: boolean;
  authorizationUrl: string | null;
  requiresReconciliation: boolean;
  reconciliationReason?: string;
};
export type RegistrationPaymentProgress =
  | { kind: 'none' }
  | { kind: 'checkout'; checkout: RegistrationCheckout; payment: Payment }
  | { kind: 'retry'; payment: Payment }
  | { kind: 'connection_retry'; payment?: Payment }
  | { kind: 'waiting'; payment: Payment; message: string };

type CheckoutIntent = {
  registrationId: string;
  purpose: RegistrationPaymentPurpose;
  previousReference: string | null;
  createdAt: number;
};
const INTENT_KEY = 'markchat_registration_checkout_intent';
const invalidPayment = () =>
  new RegistrationError(
    'Payment confirmation could not be verified. Check again or contact support before making another payment.'
  );

function paymentStorage(): CustomerStorage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function readIntent(storage: CustomerStorage | undefined): CheckoutIntent | null {
  const raw = storage?.getItem(INTENT_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (
      typeof value.registrationId === 'string' &&
      value.registrationId &&
      ['account_verification', 'subscription'].includes(value.purpose) &&
      (value.previousReference === null ||
        (typeof value.previousReference === 'string' &&
          /^[a-zA-Z0-9_-]{8,100}$/.test(value.previousReference))) &&
      Number.isFinite(value.createdAt)
    )
      return value;
  } catch {
    /* A malformed recovery marker cannot authorize a second request. */
  }
  throw invalidPayment();
}

function validatePayment(
  data: Record<string, unknown>,
  purpose: RegistrationPaymentPurpose,
  expected?: PendingRegistrationPayment | null
): Payment {
  const retryAllowed = data.status === 'failed' || data.status === 'abandoned';
  const hasUrl = typeof data.authorizationUrl === 'string';
  if (
    typeof data.reference !== 'string' ||
    !/^[a-zA-Z0-9_-]{8,100}$/.test(data.reference) ||
    !['pending', 'success', 'failed', 'abandoned'].includes(String(data.status)) ||
    data.purpose !== purpose ||
    data.currency !== 'KES' ||
    !Number.isSafeInteger(data.amountKesCents) ||
    Number(data.amountKesCents) <= 0 ||
    data.retryAllowed !== retryAllowed ||
    (data.authorizationUrl !== null && !hasUrl) ||
    (hasUrl && (data.status !== 'pending' || !registrationCheckoutUrl(data.authorizationUrl))) ||
    data.requiresReconciliation !==
      ((data.status === 'pending' && !hasUrl) ||
        (data.status === 'success' && data.requiresReconciliation === true)) ||
    (expected &&
      (data.reference !== expected.reference ||
        data.purpose !== expected.purpose ||
        data.amountKesCents !== expected.amountKesCents))
  )
    throw invalidPayment();
  return data as Payment;
}

async function paymentRequest(
  apiUrl: string,
  registration: Registration,
  path: string,
  fetcher: typeof fetch
) {
  if (!registration.verificationToken)
    throw new RegistrationError(
      'Your payment authorization expired. Contact support to resume this workspace; do not pay again.'
    );
  return registrationRequest(
    apiUrl,
    `/api/v1/registration/${encodeURIComponent(registration.registrationId)}/payments${path}`,
    { headers: { Authorization: `Bearer ${registration.verificationToken}` } },
    fetcher
  );
}

async function lookupPayment(
  apiUrl: string,
  registration: Registration,
  purpose: RegistrationPaymentPurpose,
  expected: PendingRegistrationPayment | null,
  fetcher: typeof fetch
): Promise<Payment | null> {
  const path = expected
    ? '/' + encodeURIComponent(expected.reference)
    : '?purpose=' + encodeURIComponent(purpose);
  const data = await paymentRequest(apiUrl, registration, path, fetcher);
  // registrationRequest preserves the envelope when data is null. Only discovery
  // may explicitly establish that this registration has no recorded payment yet.
  if (!expected && data.success === true && data.data === null) return null;
  return validatePayment(data, purpose, expected);
}

export async function recoverRegistrationPaymentReference(
  apiUrl: string,
  registration: Registration,
  reference: string,
  options: PaymentOptions = {}
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(reference)) throw invalidPayment();
  const storage = options.storage || paymentStorage();
  const data = await paymentRequest(
    apiUrl,
    registration,
    '/' + encodeURIComponent(reference),
    options.fetcher || fetch
  );
  if (
    data.reference !== reference ||
    (data.purpose !== 'account_verification' && data.purpose !== 'subscription')
  )
    throw invalidPayment();
  const pending = readPendingRegistrationPayment(storage);
  const expected = pending?.registrationId === registration.registrationId ? pending : null;
  const payment = validatePayment(data, data.purpose, expected);
  savePendingRegistrationPayment(
    {
      registrationId: registration.registrationId,
      reference: payment.reference,
      purpose: payment.purpose,
      amountKesCents: payment.amountKesCents,
    },
    storage
  );
}

export async function getRegistrationPaymentProgress(
  apiUrl: string,
  registration: Registration,
  purpose: RegistrationPaymentPurpose,
  options: PaymentOptions = {}
): Promise<RegistrationPaymentProgress> {
  const storage = options.storage || paymentStorage();
  const fetcher = options.fetcher || fetch;
  const pending = readPendingRegistrationPayment(storage);
  const expected =
    pending?.registrationId === registration.registrationId && pending.purpose === purpose
      ? pending
      : null;
  let payment = await lookupPayment(apiUrl, registration, purpose, expected, fetcher);
  if (expected && payment?.retryAllowed) {
    // A lost retry response may have left a newer active attempt on the server.
    // Discover it before deciding that the older failed reference can be replaced.
    const latest = await lookupPayment(apiUrl, registration, purpose, null, fetcher);
    if (!latest) throw invalidPayment();
    payment =
      latest.reference === expected.reference ? validatePayment(latest, purpose, expected) : latest;
  }
  const savedIntent = readIntent(storage);
  const intent =
    savedIntent?.registrationId === registration.registrationId && savedIntent.purpose === purpose
      ? savedIntent
      : null;
  if (intent && (!payment || payment.reference === intent.previousReference)) {
    // No automatic repost after a lost response. The user may explicitly retry
    // after this authoritative read; CP's pending/success guard handles late POSTs.
    if (!payment || payment.retryAllowed)
      return { kind: 'connection_retry', ...(payment ? { payment } : {}) };
  }
  if (!payment) return { kind: 'none' };
  savePendingRegistrationPayment(
    {
      registrationId: registration.registrationId,
      reference: payment.reference,
      purpose,
      amountKesCents: payment.amountKesCents,
    },
    storage
  );
  if (intent && payment.reference !== intent.previousReference) storage?.removeItem(INTENT_KEY);
  if (payment.retryAllowed) return { kind: 'retry', payment };
  if (payment.status === 'pending' && payment.authorizationUrl) {
    return {
      kind: 'checkout',
      payment,
      checkout: {
        reference: payment.reference,
        authorizationUrl: payment.authorizationUrl,
        amountKesCents: payment.amountKesCents,
        currency: payment.currency,
      },
    };
  }
  return {
    kind: 'waiting',
    payment,
    message:
      payment.status === 'success'
        ? payment.requiresReconciliation
          ? 'Your payment has been received. MarkChat support must reconcile it with the workspace plan before it can be applied. Share the payment reference with support and do not pay again.'
          : 'Your payment is confirmed. Workspace activation is still processing; do not pay again.'
        : 'Payment initialization is awaiting confirmation. Check again or contact support; do not make another payment.',
  };
}

export async function prepareRegistrationPayment(
  apiUrl: string,
  registration: Registration,
  purpose: RegistrationPaymentPurpose,
  options: PaymentOptions = {}
): Promise<RegistrationPaymentProgress> {
  const storage = options.storage || paymentStorage();
  const progress = await getRegistrationPaymentProgress(apiUrl, registration, purpose, {
    ...options,
    storage,
  });
  if (
    progress.kind === 'checkout' ||
    progress.kind === 'waiting' ||
    (progress.kind !== 'none' && !options.allowRetry)
  )
    return progress;
  if (!storage)
    throw new RegistrationError('Enable browser session storage before continuing to payment.');
  const previousReference = 'payment' in progress ? progress.payment?.reference || null : null;
  // Persist a minimal intent before contacting the provider, including when there
  // is no reference yet. Credentials and capabilities remain in their own scope.
  storage.setItem(
    INTENT_KEY,
    JSON.stringify({
      registrationId: registration.registrationId,
      purpose,
      previousReference,
      createdAt: Date.now(),
    })
  );
  const pending = readPendingRegistrationPayment(storage);
  if (
    'payment' in progress &&
    progress.payment?.retryAllowed &&
    pending?.registrationId === registration.registrationId &&
    pending.reference === progress.payment.reference &&
    pending.purpose === purpose
  )
    clearPendingRegistrationPayment(storage);
  const checkout = await startRegistrationCheckout(apiUrl, registration, purpose, options.fetcher);
  savePendingRegistrationPayment(
    {
      registrationId: registration.registrationId,
      reference: checkout.reference,
      purpose,
      amountKesCents: checkout.amountKesCents,
    },
    storage
  );
  storage.removeItem(INTENT_KEY);
  return {
    kind: 'checkout',
    checkout,
    payment: {
      ...checkout,
      purpose,
      status: 'pending',
      retryAllowed: false,
      requiresReconciliation: false,
    },
  };
}
