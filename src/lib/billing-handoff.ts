import {
  persistCustomerSession,
  readCustomerSession,
  type CustomerStorage,
  type CustomerStores,
} from './customer-session.ts';

const STORAGE_KEY = 'markchat_billing_handoff';
const BINDING_LIFETIME = 5 * 60 * 1000;
const STATE = /^[a-f0-9]{32}$/;
const VERIFIER = /^[A-Za-z0-9_-]{43}$/;
const CORE_ORIGIN = 'https://app.markchat.co.ke';

type BillingContext = {
  pageUrl: string;
  coreUrl: string;
  storage?: CustomerStorage;
  stores: CustomerStores;
  crypto: Crypto;
  fetcher: typeof fetch;
  now: () => number;
  navigate: (url: string) => void;
  replaceUrl: (url: string) => void;
};
type Binding = {
  accountId: string;
  state: string;
  verifier: string;
  coreOrigin: string;
  createdAt: number;
  intent: { plan: string | null; interval: string | null };
};
export type BillingSession = {
  token: string | null;
  accountId: string | null;
  redirecting: boolean;
};

function isLocalPage(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function safeCoreBillingOrigin(value: string, pageOrigin: string): string | null {
  // Reject raw path tricks before URL() normalizes them.
  if (!/^https?:\/\/[a-zA-Z0-9.:[\]-]+\/?$/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.origin === CORE_ORIGIN) return url.origin;
    if (
      isLocalPage(pageOrigin) &&
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      ['3000', '8088'].includes(url.port)
    )
      return url.origin;
  } catch {
    return null;
  }
  return null;
}

function accountId(value: string | null): string | null {
  return value && /^[1-9][0-9]{0,9}$/.test(value) && Number(value) <= 2147483647 ? value : null;
}
function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function invalidHandoff(): Error {
  return new Error(
    'The secure workspace connection expired or could not be verified. Reopen Billing from your workspace.'
  );
}
function apiOrigin(apiUrl: string, pageOrigin: string): string {
  try {
    const url = new URL(apiUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(isLocalPage(pageOrigin) && isLocalPage(url.origin)))
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error('The billing service is not configured for this site. Contact support.');
  }
}

export function createBillingHandoff(context: BillingContext) {
  const page = new URL(context.pageUrl);
  const clearPreviousSession = () => {
    for (const storage of [context.stores.session, context.stores.local]) {
      if (!storage) continue;
      try {
        storage.removeItem('markchat_cp_token');
      } catch {
        // A readable stale identity must not survive a failed Core handoff.
      }
      let previous: string | null = null;
      try {
        previous = storage.getItem('markchat_cp_token');
      } catch {
        // Inaccessible storage cannot supply a cached identity either.
      }
      if (previous) {
        throw new Error(
          'An earlier customer session could not be cleared. Clear browser storage and reconnect your workspace.'
        );
      }
    }
  };
  const clearBinding = () => {
    try {
      context.storage?.removeItem(STORAGE_KEY);
    } catch {
      /* Expiry still prevents reuse. */
    }
  };
  const readBinding = (): Binding | null => {
    try {
      const raw = context.storage?.getItem(STORAGE_KEY);
      if (!raw || raw.length > 2048) return null;
      const value = JSON.parse(raw) as Binding;
      if (
        !value ||
        !accountId(value.accountId) ||
        !STATE.test(value.state) ||
        !VERIFIER.test(value.verifier) ||
        !Number.isSafeInteger(value.createdAt) ||
        context.now() < value.createdAt ||
        context.now() - value.createdAt > BINDING_LIFETIME ||
        safeCoreBillingOrigin(value.coreOrigin, page.origin) !== value.coreOrigin
      )
        return null;
      return value;
    } catch {
      return null;
    }
  };

  async function begin(selectedAccountId: string): Promise<void> {
    if (!accountId(selectedAccountId))
      throw new Error('Choose a valid workspace before opening Billing.');
    clearPreviousSession();
    const coreOrigin = safeCoreBillingOrigin(context.coreUrl, page.origin);
    if (!coreOrigin)
      throw new Error('The workspace billing connection is not configured. Contact support.');
    if (!context.storage || !context.crypto?.subtle)
      throw new Error('Enable browser session storage to connect your workspace securely.');
    const verifier = base64url(context.crypto.getRandomValues(new Uint8Array(32)));
    const state = Array.from(context.crypto.getRandomValues(new Uint8Array(16)), (value) =>
      value.toString(16).padStart(2, '0')
    ).join('');
    const challenge = base64url(
      new Uint8Array(
        await context.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
      )
    );
    const binding: Binding = {
      accountId: selectedAccountId,
      state,
      verifier,
      coreOrigin,
      createdAt: context.now(),
      intent: { plan: page.searchParams.get('plan'), interval: page.searchParams.get('interval') },
    };
    try {
      context.storage.setItem(STORAGE_KEY, JSON.stringify(binding));
      if (context.storage.getItem(STORAGE_KEY) !== JSON.stringify(binding)) throw new Error();
    } catch {
      throw new Error('Browser session storage could not save the secure workspace connection.');
    }
    const url = new URL('/_cp/billing/start', coreOrigin);
    url.searchParams.set('account_id', selectedAccountId);
    url.searchParams.set('state', state);
    url.searchParams.set('challenge', challenge);
    context.navigate(url.href);
  }

  async function prepare(apiUrl: string): Promise<BillingSession> {
    apiOrigin(apiUrl, page.origin);
    const accounts = page.searchParams.getAll('account_id');
    const selectedAccountId = accountId(accounts[0] ?? null);
    const fromCore = page.searchParams.get('source') === 'core';
    const fragment = new URLSearchParams(page.hash.slice(1));
    const hasHandoff = fragment.has('core_handoff');
    // The short-lived proof is never left in history or sent as an HTTP referrer.
    if (hasHandoff) context.replaceUrl(page.pathname + page.search);
    if (
      accounts.length > 1 ||
      (accounts.length && !selectedAccountId) ||
      (fromCore && !selectedAccountId)
    ) {
      throw new Error(
        'The workspace account could not be verified. Open Billing from your workspace.'
      );
    }
    if (fromCore) clearPreviousSession();
    if (page.searchParams.has('handoff_error')) {
      clearBinding();
      const errorCode = page.searchParams.get('handoff_error');
      page.searchParams.delete('source');
      page.searchParams.delete('handoff_error');
      context.replaceUrl(page.pathname + page.search);
      throw new Error(
        errorCode === 'sign_in_required'
          ? 'Your workspace session expired. Sign in to continue to Billing.'
          : 'A workspace administrator is required to manage billing for this account.'
      );
    }
    if (hasHandoff) {
      const binding = readBinding();
      const token = fragment.get('core_handoff');
      if (
        !binding ||
        !fromCore ||
        selectedAccountId !== binding.accountId ||
        fragment.getAll('core_handoff').length !== 1 ||
        fragment.getAll('state').length !== 1 ||
        fragment.get('state') !== binding.state ||
        !token ||
        token.length < 100 ||
        token.length > 4096 ||
        /\s/.test(token) ||
        Array.from(token).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        ) ||
        safeCoreBillingOrigin(context.coreUrl, page.origin) !== binding.coreOrigin
      ) {
        clearBinding();
        throw invalidHandoff();
      }
      try {
        const response = await context.fetcher(binding.coreOrigin + '/_cp/billing/session', {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            handoffToken: token,
            verifier: binding.verifier,
            state: binding.state,
            accountId: Number(binding.accountId),
          }),
          signal: AbortSignal.timeout(10000),
        });
        const body = await response.json().catch(() => null);
        if (
          !response.ok ||
          body?.success !== true ||
          body.accountId !== Number(binding.accountId) ||
          typeof body.token !== 'string'
        )
          throw invalidHandoff();
        persistCustomerSession(body.token, context.stores);
        clearBinding();
        // Preserve only canonical checkout intent across the fixed callback.
        if (['starter', 'growth', 'scale'].includes(binding.intent?.plan || '')) {
          page.searchParams.set('plan', binding.intent.plan!);
        }
        if (['monthly', 'annual'].includes(binding.intent?.interval || '')) {
          page.searchParams.set('interval', binding.intent.interval!);
        }
        page.searchParams.delete('source');
        context.replaceUrl(page.pathname + page.search);
        return { token: body.token, accountId: selectedAccountId, redirecting: false };
      } catch {
        clearBinding();
        throw invalidHandoff();
      }
    }
    const token = readCustomerSession(context.stores);
    if (fromCore && selectedAccountId) {
      // A matching account does not prove the cached token belongs to the current Core user.
      await begin(selectedAccountId);
      return { token: null, accountId: selectedAccountId, redirecting: true };
    }
    return { token, accountId: selectedAccountId, redirecting: false };
  }

  return { prepare, begin };
}

function browserContext(): BillingContext {
  const stores: CustomerStores = {};
  try {
    stores.session = window.sessionStorage;
  } catch {
    /* Handshake reports unavailable storage. */
  }
  try {
    stores.local = window.localStorage;
  } catch {
    /* Session storage can still work. */
  }
  const container = document.getElementById('billing-portal-container');
  return {
    pageUrl: window.location.href,
    coreUrl: container?.dataset.coreUrl || CORE_ORIGIN,
    storage: stores.session,
    stores,
    crypto: window.crypto,
    fetcher: window.fetch.bind(window),
    now: Date.now,
    navigate: (url) => window.location.assign(url),
    replaceUrl: (url) => window.history.replaceState(null, '', url),
  };
}

export async function prepareBillingSession(apiUrl: string): Promise<BillingSession> {
  return createBillingHandoff(browserContext()).prepare(apiUrl);
}
export async function beginCoreBillingHandoff(selectedAccountId: string): Promise<void> {
  return createBillingHandoff(browserContext()).begin(selectedAccountId);
}
