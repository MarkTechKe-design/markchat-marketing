import type { CustomerStorage } from './customer-session.ts';

const STORAGE_KEY = 'markchat_billing_checkout_intent';
export type BillingCheckoutIntent = {
  tenantId: string;
  key: string;
  fingerprint: string;
  reference: string | null;
  selection: { planId: string; paymentMethod: string; billingCycle: string };
};

function browserStorage(): CustomerStorage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function readBillingCheckoutIntent(
  tenantId: string,
  storage = browserStorage()
): BillingCheckoutIntent | null {
  try {
    const value = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
    if (!value || value.tenantId !== tenantId) return null;
    if (
      /^[a-f0-9-]{36}$/.test(value.key) &&
      /^[a-f0-9]{64}$/.test(value.fingerprint) &&
      (value.reference === null || /^[a-zA-Z0-9_-]{8,100}$/.test(value.reference)) &&
      ['starter', 'growth', 'scale'].includes(value.selection?.planId) &&
      ['mpesa', 'card'].includes(value.selection?.paymentMethod) &&
      ['monthly', 'annual'].includes(value.selection?.billingCycle)
    )
      return value;
  } catch {
    /* A malformed marker cannot authorize payment or another tenant. */
  }
  return null;
}

export async function beginBillingCheckoutIntent(
  tenantId: string,
  payload: Record<string, string>,
  storage = browserStorage()
): Promise<BillingCheckoutIntent> {
  if (!storage)
    throw new Error(
      'Enable browser session storage before starting checkout so payment retries can be recovered safely.'
    );
  const selection = {
    planId: payload.planId,
    paymentMethod: payload.paymentMethod,
    billingCycle: payload.billingCycle || 'monthly',
  };
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify({
        tenantId,
        ...selection,
        phone: payload.phone || '',
        accountId: payload.account_id || '',
      })
    )
  );
  const fingerprint = Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  const previous = readBillingCheckoutIntent(tenantId, storage);
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new Error(
        'An earlier checkout is still awaiting confirmation. Refresh billing details before changing the plan, payment method, or phone.'
      );
    return previous;
  }
  const intent = { tenantId, key: crypto.randomUUID(), fingerprint, reference: null, selection };
  storage.setItem(STORAGE_KEY, JSON.stringify(intent));
  return intent;
}

export function recordBillingCheckoutReference(
  tenantId: string,
  reference: string,
  storage = browserStorage()
): void {
  const intent = readBillingCheckoutIntent(tenantId, storage);
  if (intent && /^[a-zA-Z0-9_-]{8,100}$/.test(reference))
    storage?.setItem(STORAGE_KEY, JSON.stringify({ ...intent, reference }));
}

export function clearBillingCheckoutIntent(
  referenceOrKey: string,
  storage = browserStorage()
): void {
  try {
    const intent = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
    if (intent?.reference === referenceOrKey || intent?.key === referenceOrKey)
      storage?.removeItem(STORAGE_KEY);
  } catch {
    /* The server remains authoritative when browser storage is unavailable. */
  }
}
