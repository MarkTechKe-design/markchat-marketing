/** Customer sessions are separate from the marketing CMS administrator session. */
export type CustomerStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type CustomerStores = { local?: CustomerStorage; session?: CustomerStorage };

const TOKEN_KEY = 'markchat_cp_token';
const CORE_ORIGIN = 'https://app.markchat.co.ke';
const LOCAL_CORE_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:8088',
  'http://127.0.0.1:8088',
]);

function browserOrigin(): string {
  try {
    return window.location.origin;
  } catch {
    return '';
  }
}

function isLocalPage(origin: string): boolean {
  try {
    const page = new URL(origin);
    return (
      ['http:', 'https:'].includes(page.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(page.hostname)
    );
  } catch {
    return false;
  }
}

function browserStores(): CustomerStores {
  const stores: CustomerStores = {};
  try {
    stores.local = window.localStorage;
  } catch {
    /* Browser storage can be disabled. */
  }
  try {
    stores.session = window.sessionStorage;
  } catch {
    /* Try each storage independently. */
  }
  return stores;
}

function validToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 16384 &&
    value.trim() === value &&
    !/\s/.test(value) &&
    !hasControlCharacters(value)
  );
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
  );
}

export function persistCustomerSession(token: unknown, stores = browserStores()): void {
  if (!validToken(token)) throw new Error('A verified customer session was not received.');
  let stored = false;
  for (const storage of [stores.local, stores.session]) {
    if (!storage) continue;
    try {
      storage.setItem(TOKEN_KEY, token);
      stored = true;
    } catch {
      // Never leave another customer's old token in a partially updated store.
      try {
        storage.removeItem(TOKEN_KEY);
      } catch {
        /* Read access can also be blocked. */
      }
      try {
        const previous = storage.getItem(TOKEN_KEY);
        if (previous && previous !== token) {
          throw new Error(
            'An earlier customer session could not be replaced. Clear browser storage and sign in again.'
          );
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('An earlier customer session'))
          throw error;
      }
    }
  }
  if (!stored)
    throw new Error(
      'Browser storage is unavailable. Enable storage to save your customer session.'
    );
}

export function readCustomerSession(stores = browserStores()): string | null {
  for (const storage of [stores.session, stores.local]) {
    try {
      const value = storage?.getItem(TOKEN_KEY);
      if (validToken(value)) return value;
    } catch {
      /* Continue to the other store. */
    }
  }
  return null;
}

export function safeLocalRedirect(value: unknown, fallback = '/billing'): string {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    !/^\/(?![/\\])/.test(value) ||
    /[\\:#]/.test(value) ||
    hasControlCharacters(value) ||
    /%(?:0[0-9a-f]|7f|2e|2f|5c|25)/i.test(value) ||
    /(?:^|\/)\.{1,2}(?:\/|\?|$)/.test(value)
  )
    return fallback;
  return value;
}

export function safeSsoRedirect(value: unknown, pageOrigin = browserOrigin()): string | null {
  if (
    typeof value !== 'string' ||
    value.length > 8192 ||
    /[\\\s#]/.test(value) ||
    hasControlCharacters(value)
  )
    return null;
  // Check the original path before URL() removes dot segments or normalizes slashes.
  const path = /^https?:\/\/[^/?#]+(\/[^?#]*)/.exec(value)?.[1];
  if (
    !path?.startsWith('/app/') ||
    path.includes('%') ||
    path.includes('//') ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(path)
  )
    return null;
  try {
    const candidate = new URL(value);
    const allowedOrigin =
      candidate.origin === CORE_ORIGIN ||
      (isLocalPage(pageOrigin) && LOCAL_CORE_ORIGINS.has(candidate.origin));
    if (
      candidate.username ||
      candidate.password ||
      !allowedOrigin ||
      !candidate.pathname.startsWith('/app/')
    )
      return null;
    return candidate.href;
  } catch {
    return null;
  }
}

export function customerDestination(
  ssoUrl: unknown,
  redirectTarget: unknown = '/billing',
  pageOrigin = browserOrigin()
): string {
  return safeSsoRedirect(ssoUrl, pageOrigin) || safeLocalRedirect(redirectTarget);
}
