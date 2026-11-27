import type { EdgeEnv } from './edge-security.ts';
import { trustedHttpsBase, safeText } from './edge-security.ts';

export interface PublishedPlan {
  name: string;
  priceKes: number | null;
  features: string[];
}
export interface PublishedFeature {
  title: string;
  description: string;
}
export interface PublishedTruth {
  plans: PublishedPlan[];
  features: PublishedFeature[];
  authoritative: boolean;
}
const UNVERIFIED = /\b(?:escrow|guaranteed?|certified|SLA|99\.4%|\+40%|4x faster|72.hour free trial)\b/i;
const safeClaim = (value: unknown, cap: number): string | null => {
  const text = safeText(value, cap);
  return text && !UNVERIFIED.test(text) ? text : null;
};
async function getJson(base: URL | null, endpoint: string, token?: string): Promise<unknown> {
  if (!base) return null;
  try {
    const url = new URL(endpoint, base);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      signal: AbortSignal.timeout(2200),
      cache: 'no-store',
      redirect: 'error',
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
export async function fetchPublishedMarketingTruth(env: EdgeEnv): Promise<PublishedTruth> {
  // Mirrors public CMS endpoints consumed by src/lib/cms-api.ts.
  const cms = trustedHttpsBase(env.CMS_API_BASE_URL);
  const control = trustedHttpsBase(env.CONTROL_PLANE_API_URL);
  const [rawFeatures, rawCatalog] = await Promise.all([
    getJson(cms, '/api/public/features', env.CMS_SERVICE_TOKEN),
    getJson(control, '/api/v1/billing/plans'),
  ]);
  const featuresData = Array.isArray(rawFeatures)
    ? rawFeatures
    : rawFeatures && typeof rawFeatures === 'object' && Array.isArray((rawFeatures as { data?: unknown }).data)
      ? (rawFeatures as { data: unknown[] }).data
      : [];
  const features: PublishedFeature[] = featuresData.filter((entry) => {
    return entry && typeof entry === 'object' && (entry as Record<string, unknown>).status === 'published';
  }).slice(0, 15).flatMap((entry) => {
    const item = entry as Record<string, unknown>;
    const title = safeClaim(item.title, 120), description = safeClaim(item.description, 300);
    return title && description ? [{ title, description }] : [];
  });
  let data: unknown = rawCatalog;
  if (data && typeof data === 'object' && !Array.isArray(data) && 'data' in data) data = (data as { data: unknown }).data;
  const plans = Array.isArray(data) ? data :
    data && typeof data === 'object' && 'plans' in data && Array.isArray((data as { plans: unknown }).plans)
      ? (data as { plans: unknown[] }).plans : [];
  const publishedPlans: PublishedPlan[] = plans.slice(0, 8).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    if (item.isActive === false || item.is_active === false) return [];
    const name = safeClaim(item.name || item.id, 60);
    if (!name) return [];
    const kes = typeof item.priceKes === 'number' ? item.priceKes :
      typeof item.priceKesCents === 'number' ? item.priceKesCents / 100 : null;
    const priceKes = kes !== null && Number.isFinite(kes) && kes >= 0 && kes < 1_000_000 ? kes : null;
    const items = Array.isArray(item.features) ? item.features : [];
    const feat = items.slice(0, 10).flatMap(v => {
      const text = safeClaim(v, 150); return text ? [text] : [];
    });
    return [{ name, priceKes, features: feat }];
  });
  return {
    plans: publishedPlans,
    features,
    authoritative: publishedPlans.length > 0 || features.length > 0,
  };
}
export function productGuide(question: string, truth: PublishedTruth): string {
  const q = question.toLowerCase();
  if (/price|plan|cost|kes|subscription|billing/.test(q)) {
    if (truth.plans.length === 0) {
      return 'Current plan pricing is not available from our published catalog right now. Please check https://markchat.co.ke/pricing or contact hello@markchat.co.ke for confirmed rates.';
    }
    const prices = truth.plans.map(p => p.name + ': ' +
      (p.priceKes === null ? 'contact sales for confirmed pricing' :
        'KES ' + p.priceKes.toLocaleString('en-KE') + '/month'));
    return 'The currently published MarkChat Core plans are: ' + prices.join('; ') +
      '. Provider setup and transaction fees are separate. Please confirm your choice on the pricing page.';
  }
  if (/pochi|paybill|till|daraja|stk|m.pesa|payment/.test(q)) {
    return 'M-Pesa STK Push and Paybill/Till verification require merchant authorization and provider setup. Payments settle to the merchant’s own Safaricom or payment-provider account; MarkChat does not hold or escrow funds. Ask our team which integrations are currently available for your business.';
  }
  if (/sms|africa.s talking|sender id/.test(q)) {
    return 'Bulk SMS and Africa’s Talking carrier services are separate from MarkChat Core subscriptions. Setup, sender approval, and carrier billing must be confirmed separately. Contact hello@markchat.co.ke for options.';
  }
  if (/demo|book|call|contact|sales/.test(q)) {
    return 'You can request a tailored demonstration at https://markchat.co.ke/demo or leave your details here. We will confirm availability and next steps by email.';
  }
  if (/feature|integration|whatsapp|instagram|channel|inbox|copilot|ai/.test(q) && truth.features.length) {
    return 'Published MarkChat capabilities include: ' +
      truth.features.slice(0, 5).map(f => f.title).join(', ') +
      '. Channel access depends on provider permissions and workspace configuration. See https://markchat.co.ke/features for details.';
  }
  return 'MarkChat™ helps teams organize supported customer conversations, review AI-assisted replies, and configure eligible M-Pesa workflows. What would you like to know about features, plan pricing, payment integrations, or a live demo?';
}
