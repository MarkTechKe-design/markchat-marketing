import { safeLocalRedirect, safeSsoRedirect } from './customer-session.ts';
import { registrationCheckoutUrl } from './registration-client.ts';

export type BillingCycle = 'monthly' | 'annual';
export type BillingPlanId = 'starter' | 'growth' | 'scale';
export type BillingPlan = {
  id: BillingPlanId;
  name: string;
  priceKesCents: number;
  annualPriceKesCents?: number;
  maxAgents: number;
  maxInboxes: number | null;
};
export type BillingCapabilities = { billingCycles?: unknown; annualDiscountPercent?: unknown };
export type BillingCatalog = {
  plans: BillingPlan[];
  billingCycles: BillingCycle[];
  annualDiscountPercent: number | null;
};
export type BillingQuote = BillingPlan & {
  billingCycle: BillingCycle;
  amountKesCents: number;
  monthlyEquivalentKesCents: number;
  savingKesCents: number;
};

const PLAN_IDS: BillingPlanId[] = ['starter', 'growth', 'scale'];
const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

export function parseBillingCatalog(value: unknown): BillingCatalog {
  const data = record(value);
  if (!Array.isArray(data.plans)) throw new Error('Current pricing could not be verified.');
  const plans = PLAN_IDS.map((id) => {
    const matches = (data.plans as unknown[]).map(record).filter((plan) => plan.id === id);
    const plan = matches[0];
    if (
      matches.length !== 1 ||
      !positiveInteger(plan?.priceKesCents) ||
      !positiveInteger(plan?.maxAgents) ||
      (plan?.maxInboxes !== null && !positiveInteger(plan?.maxInboxes))
    )
      throw new Error('Current pricing could not be verified. Please refresh before paying.');
    return {
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      priceKesCents: plan.priceKesCents,
      maxAgents: plan.maxAgents,
      maxInboxes: plan.maxInboxes as number | null,
      ...(positiveInteger(plan.annualPriceKesCents)
        ? { annualPriceKesCents: plan.annualPriceKesCents }
        : {}),
    };
  });
  const supportsAnnual =
    Array.isArray(data.billingCycles) &&
    data.billingCycles.includes('annual') &&
    data.annualDiscountPercent === 20 &&
    plans.every((plan) => plan.annualPriceKesCents === (plan.priceKesCents * 12 * 80) / 100);
  return {
    plans,
    billingCycles: supportsAnnual ? ['monthly', 'annual'] : ['monthly'],
    annualDiscountPercent: supportsAnnual ? 20 : null,
  };
}

export function supportsAnnualBilling(
  catalog: BillingCatalog,
  capabilities?: BillingCapabilities
): boolean {
  return (
    catalog.billingCycles.includes('annual') &&
    catalog.annualDiscountPercent === 20 &&
    Array.isArray(capabilities?.billingCycles) &&
    capabilities.billingCycles.includes('annual') &&
    capabilities.annualDiscountPercent === 20
  );
}

export function billingQuote(
  catalog: BillingCatalog,
  planId: string,
  billingCycle: BillingCycle,
  capabilities?: BillingCapabilities
): BillingQuote {
  const plan = catalog.plans.find((candidate) => candidate.id === planId);
  if (!plan) throw new Error('Select an available workspace plan.');
  if (billingCycle === 'annual' && !supportsAnnualBilling(catalog, capabilities))
    throw new Error('Annual checkout is not enabled by the billing service. Choose monthly.');
  const amountKesCents = billingCycle === 'annual' ? plan.annualPriceKesCents! : plan.priceKesCents;
  return {
    ...plan,
    billingCycle,
    amountKesCents,
    monthlyEquivalentKesCents:
      billingCycle === 'annual' ? Math.round(amountKesCents / 12) : amountKesCents,
    savingKesCents: billingCycle === 'annual' ? plan.priceKesCents * 12 - amountKesCents : 0,
  };
}

export function formatKes(cents: number): string {
  return new Intl.NumberFormat('en-KE', {
    style: 'currency',
    currency: 'KES',
    currencyDisplay: 'code',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function normalizeKenyanPhone(value: string): string | null {
  if (/[^+\d ()-]/.test(value)) return null;
  const phone = value.replace(/[ ()-]/g, '');
  if (/^0[17]\d{8}$/.test(phone)) return '+254' + phone.slice(1);
  if (/^\+?254[17]\d{8}$/.test(phone)) return '+' + phone.replace(/^\+/, '');
  return null;
}

export function billingCheckoutPayload(input: {
  quote: BillingQuote;
  paymentMethod: 'card' | 'mpesa';
  phone?: string;
  callbackUrl: string;
  accountId?: string | null;
}): Record<string, string> {
  const phone = input.paymentMethod === 'mpesa' ? normalizeKenyanPhone(input.phone || '') : null;
  if (input.paymentMethod === 'mpesa' && !phone)
    throw new Error('Enter a valid Kenyan M-Pesa phone number, such as 0712 345 678.');
  return {
    planId: input.quote.id,
    paymentMethod: input.paymentMethod,
    callbackUrl: input.callbackUrl,
    ...(input.quote.billingCycle === 'annual' ? { billingCycle: 'annual' } : {}),
    ...(phone ? { phone } : {}),
    ...(input.accountId ? { account_id: input.accountId } : {}),
  };
}

export type BillingCheckout = {
  reference: string;
  authorizationUrl: string | null;
  amountKesCents: number;
  currency: 'KES';
};

export function validateBillingCheckout(value: unknown, quote: BillingQuote): BillingCheckout {
  const data = record(value);
  const url = registrationCheckoutUrl(data.authorizationUrl);
  const pendingWithoutUrl =
    data.authorizationUrl === null &&
    data.status === 'pending' &&
    data.requiresReconciliation === true &&
    data.retryAllowed === false;
  const terminalWithoutUrl =
    data.authorizationUrl === null &&
    ['success', 'failed', 'abandoned'].includes(String(data.status)) &&
    (data.requiresReconciliation === false ||
      (data.status === 'success' && data.requiresReconciliation === true)) &&
    data.retryAllowed === (data.status === 'failed' || data.status === 'abandoned');
  if (
    typeof data.reference !== 'string' ||
    !/^[a-zA-Z0-9_-]{8,100}$/.test(data.reference) ||
    data.amountKesCents !== quote.amountKesCents ||
    data.currency !== 'KES' ||
    (url &&
      (data.requiresReconciliation === true ||
        (data.status !== undefined && data.status !== 'pending'))) ||
    (data.planId !== undefined && data.planId !== quote.id) ||
    (data.billingCycle !== undefined && data.billingCycle !== quote.billingCycle) ||
    (quote.billingCycle === 'annual' && data.billingCycle !== 'annual') ||
    (!url && !pendingWithoutUrl && !terminalWithoutUrl)
  )
    throw new Error(
      'The checkout response could not be verified. Check your payment status before trying again.'
    );
  return {
    reference: data.reference,
    authorizationUrl: url,
    amountKesCents: quote.amountKesCents,
    currency: 'KES',
  };
}

export type ExistingBillingCheckout = BillingCheckout & {
  planId: BillingPlanId;
  paymentMethod: 'mpesa' | 'card';
  billingCycle: BillingCycle;
  status: 'pending' | 'success' | 'failed' | 'abandoned';
  requiresReconciliation: boolean;
  reconciliationReason: string | null;
};

export function parsePendingBillingCheckout(value: unknown): ExistingBillingCheckout | null {
  if (value === null) return null;
  const data = record(value);
  if (
    typeof data.reference !== 'string' ||
    !/^[a-zA-Z0-9_-]{8,100}$/.test(data.reference) ||
    !PLAN_IDS.includes(data.planId as BillingPlanId) ||
    !['monthly', 'annual'].includes(String(data.billingCycle)) ||
    !['mpesa', 'card'].includes(String(data.paymentMethod)) ||
    !['pending', 'success', 'failed', 'abandoned'].includes(String(data.status)) ||
    data.purpose !== 'subscription' ||
    data.currency !== 'KES' ||
    !positiveInteger(data.amountKesCents) ||
    (data.authorizationUrl !== null &&
      (data.status !== 'pending' || !registrationCheckoutUrl(data.authorizationUrl)))
  )
    throw new Error(
      'Your existing payment could not be verified. Contact support before paying again.'
    );
  return {
    ...data,
    requiresReconciliation: data.requiresReconciliation === true,
    reconciliationReason:
      data.reconciliationReason === 'subscription_changed' ? 'subscription_changed' : null,
  } as unknown as ExistingBillingCheckout;
}

export type SettlementProgress = {
  paymentVerified: boolean;
  entitlementsSynced: boolean;
  workspaceReady: boolean;
  launchUrl: string | null;
  failed: boolean;
  reference: string;
  amountKesCents: number;
  requiresReconciliation: boolean;
  reconciliationReason: string | null;
};

export function subscriptionSettlement(
  value: unknown,
  expectedReference: string,
  ssoUrl?: unknown,
  pageOrigin?: string
): SettlementProgress {
  const tx = record(value);
  if (
    tx.reference !== expectedReference ||
    tx.purpose !== 'subscription' ||
    tx.currency !== 'KES' ||
    !positiveInteger(tx.amountKesCents) ||
    !['pending', 'success', 'settled', 'failed', 'abandoned'].includes(String(tx.status))
  )
    throw new Error('The payment receipt could not be validated for this subscription.');
  const paymentVerified =
    (tx.status === 'success' || tx.status === 'settled') && tx.paymentConfirmed === true;
  const entitlements = record(tx.entitlements);
  const requiresReconciliation = tx.requiresReconciliation === true;
  const entitlementsSynced =
    paymentVerified &&
    !requiresReconciliation &&
    tx.entitlementsSynced === true &&
    entitlements.accessAllowed === true &&
    entitlements.coreSyncStatus === 'synced';
  const launchUrl = entitlementsSynced ? safeSsoRedirect(ssoUrl, pageOrigin) : null;
  return {
    paymentVerified,
    entitlementsSynced,
    workspaceReady: !!launchUrl,
    launchUrl,
    failed: tx.status === 'failed' || tx.status === 'abandoned',
    reference: expectedReference,
    amountKesCents: tx.amountKesCents,
    requiresReconciliation,
    reconciliationReason:
      tx.reconciliationReason === 'subscription_changed' ? 'subscription_changed' : null,
  };
}

export function billingLoginDestination(path: string): string {
  return '/login?redirect=' + encodeURIComponent(safeLocalRedirect(path));
}

export function registrationSettlement(
  statusValue: unknown,
  overviewValue: unknown
): { paymentVerified: boolean; entitlementsSynced: boolean } {
  const status = record(statusValue);
  const overview = record(overviewValue);
  const tenant = record(overview.tenant);
  const requirements = record(status.paymentRequirements);
  const entitlements = record(overview.entitlements);
  if (
    status.status !== 'completed' ||
    typeof status.tenantId !== 'string' ||
    status.tenantId !== tenant.id ||
    requirements.verification !== false ||
    requirements.subscription !== false
  )
    throw new Error('Completed workspace setup could not be verified for this signed-in account.');
  return {
    paymentVerified: true,
    entitlementsSynced:
      entitlements.accessAllowed === true && entitlements.coreSyncStatus === 'synced',
  };
}

export function trialBillingNote(value: unknown): string {
  const trial = record(value);
  if (trial.isTrial === true) {
    if (trial.isExpired === true)
      return 'Your trial has ended. A confirmed payment and workspace sync are required to restore access.';
    if (Number.isFinite(trial.hoursRemaining) && Number(trial.hoursRemaining) > 0) {
      const hours = Math.ceil(Number(trial.hoursRemaining));
      return `Your trial has ${hours} ${hours === 1 ? 'hour' : 'hours'} remaining. This checkout is charged now; it does not schedule a later payment.`;
    }
    return 'Your trial is active. This checkout is charged now; check your workspace for the current trial end time.';
  }
  return 'Your selected plan is activated after confirmed payment and workspace synchronization.';
}
