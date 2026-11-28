import { safeSsoRedirect } from './customer-session.ts';
import { RegistrationError, registrationRequest } from './registration-client.ts';
import type {
  BillingCapabilities,
  BillingCheckout,
  ExistingBillingCheckout,
} from './billing-state.ts';
import { parsePendingBillingCheckout } from './billing-state.ts';

export class BillingRecoveryRequired extends Error {
  reference: string | null;
  constructor(reference: string | null) {
    super(
      reference
        ? 'Your earlier payment must be checked before another checkout can start. This billing service cannot recover it automatically. Open the saved receipt or contact hello@markchat.co.ke; do not pay again.'
        : 'Your earlier checkout response was not confirmed, and this billing service cannot recover the attempt automatically. Contact MarkChat support at hello@markchat.co.ke before trying payment again.'
    );
    this.name = 'BillingRecoveryRequired';
    this.reference = reference && /^[a-zA-Z0-9_-]{8,100}$/.test(reference) ? reference : null;
  }
}

export async function fetchExistingBillingCheckout(
  apiUrl: string,
  token: string,
  options: {
    accountId?: string | null;
    allowLegacyMonthly?: boolean;
    intent?: { key: string; reference: string | null } | null;
  } = {},
  fetcher: typeof fetch = fetch
): Promise<ExistingBillingCheckout | null> {
  if (!token) throw new RegistrationError('Please sign in to recover workspace payments.', 401);
  try {
    const data = await registrationRequest(
      apiUrl,
      '/api/v1/billing/checkout/pending' +
        (options.accountId ? '?account_id=' + encodeURIComponent(options.accountId) : ''),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.intent ? { 'Idempotency-Key': options.intent.key } : {}),
        },
      },
      fetcher
    );
    return parsePendingBillingCheckout(data.checkout);
  } catch (error) {
    if (error instanceof RegistrationError && error.status === 404 && options.allowLegacyMonthly) {
      if (options.intent) throw new BillingRecoveryRequired(options.intent.reference);
      return null;
    }
    throw error;
  }
}

export type BillingOverview = {
  tenant: { id: string; name: string; chatwootAccountId: number | string | null };
  subscription: {
    planId: string;
    status: string;
    billingCycle: string;
    currentPeriodEnd: string | null;
  } | null;
  plan: { id: string; name: string } | null;
  entitlements: {
    accessAllowed: boolean;
    coreSyncStatus: 'pending' | 'processing' | 'failed' | 'synced';
    trialInfo: unknown;
  };
  capabilities: BillingCapabilities & { canChangePlan?: boolean; canCheckout?: boolean };
};

export async function fetchBillingSubscription(
  apiUrl: string,
  token: string,
  accountId: string | null = null,
  fetcher: typeof fetch = fetch
): Promise<BillingOverview> {
  if (!token) throw new RegistrationError('Please sign in to view workspace billing.', 401);
  const data = await registrationRequest(
    apiUrl,
    '/api/v1/billing/subscription' +
      (accountId ? '?account_id=' + encodeURIComponent(accountId) : ''),
    { headers: { Authorization: `Bearer ${token}` } },
    fetcher
  );
  const overview = data as unknown as BillingOverview;
  if (
    !overview.tenant?.id ||
    typeof overview.tenant.name !== 'string' ||
    typeof overview.entitlements?.accessAllowed !== 'boolean' ||
    !['pending', 'processing', 'failed', 'synced'].includes(
      overview.entitlements?.coreSyncStatus
    ) ||
    (overview.subscription !== null &&
      (!overview.subscription?.planId || typeof overview.subscription?.status !== 'string'))
  )
    throw new Error('The live workspace subscription could not be verified. Please refresh.');
  if (accountId && String(overview.tenant.chatwootAccountId) !== accountId)
    throw new RegistrationError(
      'This customer session belongs to another workspace account. Reconnect the requested workspace.',
      403,
      'BILLING_ACCOUNT_MISMATCH'
    );
  overview.capabilities ||= {};
  return overview;
}

export async function fetchWorkspaceDestination(
  apiUrl: string,
  token: string,
  fetcher: typeof fetch = fetch,
  pageOrigin?: string
): Promise<string> {
  if (!token) throw new RegistrationError('Please sign in to open your workspace.', 401);
  const data = await registrationRequest(
    apiUrl,
    '/api/v1/auth/sso',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    },
    fetcher
  );
  const url = safeSsoRedirect(data.url, pageOrigin);
  if (!url)
    throw new Error('A safe workspace destination was not received. Please try opening it again.');
  return url;
}

/** Keep the verified receipt's identity when refreshing its short-lived SSO URL. */
export async function prepareWorkspaceLaunch(
  apiUrl: string,
  verifiedToken: string,
  fetcher: typeof fetch = fetch,
  pageOrigin?: string
): Promise<{ url: string; launch: () => Promise<string> }> {
  const url = await fetchWorkspaceDestination(apiUrl, verifiedToken, fetcher, pageOrigin);
  return {
    url,
    launch: () => fetchWorkspaceDestination(apiUrl, verifiedToken, fetcher, pageOrigin),
  };
}

/** An existing attempt always returns to its receipt; it never invokes checkout creation. */
export async function resolveBillingCheckout(
  existing: ExistingBillingCheckout | null,
  initialize: () => Promise<BillingCheckout>
): Promise<{ reference: string; url: string }> {
  if (existing)
    return {
      reference: existing.reference,
      url: '/billing/return?reference=' + encodeURIComponent(existing.reference),
    };
  const checkout = await initialize();
  return {
    reference: checkout.reference,
    url:
      checkout.authorizationUrl ||
      '/billing/return?reference=' + encodeURIComponent(checkout.reference),
  };
}
