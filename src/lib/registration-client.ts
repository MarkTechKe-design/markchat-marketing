import { safeLocalRedirect, type CustomerStorage } from './customer-session.ts';

type Fetcher = typeof fetch;
type RequestOptions = NonNullable<Parameters<Fetcher>[1]>;
type JsonRecord = Record<string, unknown>;

export class RegistrationError extends Error {
  status: number;
  code: string;
  retryAfterSeconds: number;
  constructor(message: string, status = 0, code = '', retryAfterSeconds = 0) {
    super(message);
    this.name = 'RegistrationError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export async function registrationRequest(
  apiUrl: string,
  path: string,
  init: RequestOptions = {},
  fetcher: Fetcher = fetch
): Promise<JsonRecord> {
  const response = await fetcher(apiUrl.replace(/\/$/, '') + path, {
    ...init,
    cache: 'no-store',
    headers: { Accept: 'application/json', ...init.headers },
    signal: init.signal || AbortSignal.timeout(15000),
  });
  const envelope = await response.json().catch(() => ({}));
  if (!response.ok || envelope.success === false) {
    const message =
      typeof envelope.message === 'string' && !/stack|\bat .+\(.+:\d+/i.test(envelope.message)
        ? envelope.message
        : 'The registration service could not complete this request. Please try again.';
    // Cross-origin responses may not expose Retry-After; the CP error envelope
    // repeats that value even when its generic rate-limit code replaces OTP_RATE_LIMITED.
    const retryAfter = Number(response.headers.get('Retry-After') || envelope.retryAfter);
    throw new RegistrationError(
      message,
      response.status,
      String(envelope.code || ''),
      Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 0
    );
  }
  const result = envelope.data ?? envelope;
  if (!result || typeof result !== 'object')
    throw new RegistrationError('The registration response could not be verified.');
  return result;
}

export type RegistrationOptions = {
  trialHours: number;
  verificationRequired: boolean;
  verificationAmountKesCents: number;
  otp: { channel: 'email'; expiresInSeconds: number; resendAfterSeconds: number };
};

export async function fetchRegistrationOptions(
  apiUrl: string,
  fetcher: Fetcher = fetch
): Promise<RegistrationOptions> {
  try {
    const data = await registrationRequest(apiUrl, '/api/v1/registration/options', {}, fetcher);
    const otp = data.otp as JsonRecord | undefined;
    if (
      !Number.isSafeInteger(data.trialHours) ||
      Number(data.trialHours) < 0 ||
      typeof data.verificationRequired !== 'boolean' ||
      !Number.isSafeInteger(data.verificationAmountKesCents) ||
      Number(data.verificationAmountKesCents) < 0 ||
      (data.verificationRequired && Number(data.verificationAmountKesCents) === 0) ||
      otp?.channel !== 'email' ||
      !(Number(otp.expiresInSeconds) > 0) ||
      !(Number(otp.resendAfterSeconds) >= 0)
    ) {
      throw new Error('Invalid registration policy');
    }
    return data as RegistrationOptions;
  } catch {
    throw new RegistrationError(
      'Registration settings are temporarily unavailable. Retry to confirm the current trial and payment terms.'
    );
  }
}

export function formatTrialDuration(hours: number): string | null {
  if (!Number.isSafeInteger(hours) || hours <= 0) return null;
  if (hours % 24 === 0) return `${hours / 24} ${hours === 24 ? 'day' : 'days'}`;
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

export function registrationPasswordError(password: string): string | null {
  if (password.length < 8 || password.length > 255)
    return 'Password must be between 8 and 255 characters.';
  if (
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/\d/.test(password) ||
    !/[!@#$%^&*()_+\-=[\]{}|"/\\.,`<>:;?~']/.test(password) ||
    Array.from(password).some((character) => [10, 13, 8232, 8233].includes(character.charCodeAt(0)))
  ) {
    return 'Include an uppercase letter, a lowercase letter, a number, and a special character.';
  }
  return null;
}

export class EmailVerification {
  email = '';
  private challengeId: string | null = null;
  private challengeExpiresAt = 0;
  private resendAt = 0;
  private proof: string | null = null;
  private proofExpiresAt = 0;
  private generation = 0;
  private inFlight = false;
  private apiUrl: string;
  private fetcher: Fetcher;
  private now: () => number;

  constructor(apiUrl: string, fetcher: Fetcher = fetch, now = Date.now) {
    this.apiUrl = apiUrl;
    this.fetcher = fetcher;
    this.now = now;
  }

  setEmail(value: string): void {
    const email = value.trim().toLowerCase();
    if (email === this.email) return;
    this.email = email;
    this.generation++;
    this.challengeId = null;
    this.proof = null;
    this.proofExpiresAt = 0;
    this.challengeExpiresAt = 0;
    this.resendAt = 0;
    this.inFlight = false;
  }

  get token(): string | null {
    return this.now() < this.proofExpiresAt ? this.proof : null;
  }
  get hasChallenge(): boolean {
    return !!this.challengeId && this.now() < this.challengeExpiresAt;
  }
  get resendSeconds(): number {
    return Math.max(0, Math.ceil((this.resendAt - this.now()) / 1000));
  }
  get busy(): boolean {
    return this.inFlight;
  }

  invalidateProof(): void {
    this.generation++;
    this.proof = null;
    this.proofExpiresAt = 0;
    this.challengeId = null;
    this.challengeExpiresAt = 0;
    this.inFlight = false;
  }

  async send(): Promise<void> {
    if (this.inFlight) throw new RegistrationError('Email verification is already in progress.');
    if (this.resendSeconds)
      throw new RegistrationError(`Please wait ${this.resendSeconds} seconds before resending.`);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email))
      throw new RegistrationError('Enter a valid email address before requesting a code.');
    const generation = this.generation;
    this.inFlight = true;
    try {
      const data = await registrationRequest(
        this.apiUrl,
        '/api/v1/registration/otp/send',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: this.email, channel: 'email' }),
        },
        this.fetcher
      );
      if (generation !== this.generation)
        throw new RegistrationError('Your email changed. Request a code for the new address.');
      if (
        typeof data.challengeId !== 'string' ||
        !data.challengeId ||
        !(Number(data.expiresInSeconds) > 0) ||
        !(Number(data.resendAfterSeconds) >= 0)
      ) {
        throw new RegistrationError(
          'The email verification request could not be confirmed. Please try again.'
        );
      }
      this.challengeId = data.challengeId;
      this.challengeExpiresAt = this.now() + Number(data.expiresInSeconds) * 1000;
      this.resendAt = this.now() + Number(data.resendAfterSeconds) * 1000;
      this.proof = null;
      this.proofExpiresAt = 0;
    } catch (error) {
      if (
        generation === this.generation &&
        error instanceof RegistrationError &&
        error.status === 429
      ) {
        this.resendAt = this.now() + (error.retryAfterSeconds || 60) * 1000;
      }
      throw error;
    } finally {
      if (generation === this.generation) this.inFlight = false;
    }
  }

  async verify(code: string): Promise<void> {
    if (this.inFlight) throw new RegistrationError('Email verification is already in progress.');
    if (!/^\d{6}$/.test(code))
      throw new RegistrationError('Enter the six-digit code from your email.');
    if (!this.hasChallenge)
      throw new RegistrationError('Your code expired. Request a new email code.');
    const generation = this.generation;
    this.inFlight = true;
    try {
      const data = await registrationRequest(
        this.apiUrl,
        '/api/v1/registration/otp/verify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: this.email, challengeId: this.challengeId, code }),
        },
        this.fetcher
      );
      if (generation !== this.generation)
        throw new RegistrationError(
          'Your email changed. Verify the new address before continuing.'
        );
      if (
        typeof data.otpVerificationToken !== 'string' ||
        !data.otpVerificationToken ||
        !(Number(data.expiresInSeconds) > 0)
      ) {
        throw new RegistrationError(
          'Email verification did not return a valid proof. Request a new code.'
        );
      }
      this.proof = data.otpVerificationToken;
      this.proofExpiresAt = this.now() + Number(data.expiresInSeconds) * 1000;
    } finally {
      if (generation === this.generation) this.inFlight = false;
    }
  }
}

export type RegistrationResume = {
  registrationId: string;
  sessionToken: string;
  redirectTarget: string;
  createdAt: number;
  verificationToken?: string;
};
const RESUME_KEY = 'markchat_registration_session';

function registrationStore(): CustomerStorage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function saveRegistrationResume(
  value: Omit<RegistrationResume, 'createdAt'>,
  storage: CustomerStorage | undefined = registrationStore(),
  now = Date.now()
): void {
  if (!storage)
    throw new RegistrationError(
      'Enable browser session storage to resume workspace setup securely.'
    );
  storage.setItem(
    RESUME_KEY,
    JSON.stringify({
      registrationId: value.registrationId,
      sessionToken: value.sessionToken,
      redirectTarget: safeLocalRedirect(value.redirectTarget),
      createdAt: now,
      ...(value.verificationToken ? { verificationToken: value.verificationToken } : {}),
    })
  );
}

export function readRegistrationResume(
  storage: CustomerStorage | undefined = registrationStore(),
  now = Date.now()
): RegistrationResume | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(RESUME_KEY) || 'null');
    if (
      typeof value?.registrationId === 'string' &&
      value.registrationId &&
      typeof value.sessionToken === 'string' &&
      value.sessionToken &&
      Number.isFinite(value.createdAt) &&
      value.createdAt <= now &&
      now - value.createdAt < 60 * 60 * 1000
    ) {
      return {
        registrationId: value.registrationId,
        sessionToken: value.sessionToken,
        redirectTarget: safeLocalRedirect(value.redirectTarget),
        createdAt: value.createdAt,
        ...(typeof value.verificationToken === 'string'
          ? { verificationToken: value.verificationToken }
          : {}),
      };
    }
    storage.removeItem(RESUME_KEY);
  } catch {
    /* A disabled store cannot authorize a registration resume. */
  }
  return null;
}

export function clearRegistrationResume(
  storage: CustomerStorage | undefined = registrationStore()
): void {
  try {
    storage?.removeItem(RESUME_KEY);
  } catch {
    /* Session exchange remains single-use on the server. */
  }
}

export type CustomerHandoff = {
  token: string;
  ssoUrl?: string;
  redirectTarget?: string;
  user?: unknown;
};

export async function exchangeRegistrationSession(
  apiUrl: string,
  proof: Pick<RegistrationResume, 'registrationId' | 'sessionToken'>,
  fetcher: Fetcher = fetch
): Promise<CustomerHandoff> {
  const data = await registrationRequest(
    apiUrl,
    `/api/v1/registration/${encodeURIComponent(proof.registrationId)}/session`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${proof.sessionToken}`,
      },
      body: '{}',
    },
    fetcher
  );
  if (typeof data.token !== 'string' || !data.token.trim())
    throw new RegistrationError('A verified customer session was not received.');
  return data as CustomerHandoff;
}

export async function obtainRegistrationSession(
  apiUrl: string,
  proof: Pick<RegistrationResume, 'registrationId' | 'sessionToken'>,
  credentials?: { email: string; password: string },
  fetcher: Fetcher = fetch
): Promise<CustomerHandoff | null> {
  if (proof.sessionToken) {
    try {
      return await exchangeRegistrationSession(apiUrl, proof, fetcher);
    } catch (error) {
      if (!registrationSessionExpired(error)) throw error;
    }
  }
  // Only the original form can supply these credentials; no storage is consulted.
  if (!credentials) return null;
  const data = await registrationRequest(
    apiUrl,
    '/api/v1/auth/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    },
    fetcher
  );
  if (typeof data.token !== 'string' || !data.token.trim())
    throw new RegistrationError('A verified customer session was not received.');
  return data as CustomerHandoff;
}

export function registrationSessionExpired(error: unknown): boolean {
  return (
    error instanceof RegistrationError &&
    error.status === 401 &&
    error.code === 'REGISTRATION_SESSION_INVALID'
  );
}

export type RegistrationPaymentPurpose = 'account_verification' | 'subscription';

export function registrationPaymentRequired(
  requirements: unknown
): RegistrationPaymentPurpose | null {
  const gates = requirements as { verification?: unknown; subscription?: unknown } | undefined;
  if (typeof gates?.verification !== 'boolean' || typeof gates.subscription !== 'boolean') {
    throw new RegistrationError(
      'The registration payment requirements could not be confirmed. Please retry setup.'
    );
  }
  return gates.verification ? 'account_verification' : gates.subscription ? 'subscription' : null;
}

export type RegistrationCheckout = {
  reference: string;
  authorizationUrl: string;
  amountKesCents: number;
  currency: 'KES';
};

export function registrationCheckoutUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    /\s|\\|#/.test(value) ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    return null;
  try {
    const url = new URL(value);
    return url.origin === 'https://checkout.paystack.com' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname !== '/'
      ? value
      : null;
  } catch {
    return null;
  }
}

export async function startRegistrationCheckout(
  apiUrl: string,
  registration: { registrationId: string; verificationToken?: string },
  purpose: RegistrationPaymentPurpose,
  fetcher: Fetcher = fetch
): Promise<RegistrationCheckout> {
  if (!registration.verificationToken)
    throw new RegistrationError(
      'The registration payment authorization expired. Return to registration to resume setup.'
    );
  const route =
    purpose === 'account_verification' ? 'verification-checkout' : 'subscription-checkout';
  const data = await registrationRequest(
    apiUrl,
    `/api/v1/registration/${encodeURIComponent(registration.registrationId)}/${route}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${registration.verificationToken}`,
      },
      body: JSON.stringify({ paymentMethod: 'mpesa' }),
    },
    fetcher
  );
  const checkout = (data.checkout || data) as JsonRecord;
  if (
    !registrationCheckoutUrl(checkout.authorizationUrl) ||
    typeof checkout.reference !== 'string' ||
    !/^[a-zA-Z0-9_-]{8,100}$/.test(checkout.reference) ||
    checkout.currency !== 'KES' ||
    !Number.isSafeInteger(checkout.amountKesCents) ||
    Number(checkout.amountKesCents) <= 0
  ) {
    throw new RegistrationError(
      'The checkout details could not be validated. No payment was confirmed.'
    );
  }
  return checkout as RegistrationCheckout;
}

export type PendingRegistrationPayment = {
  registrationId: string;
  reference: string;
  purpose: RegistrationPaymentPurpose;
  amountKesCents: number;
  createdAt: number;
};
const PAYMENT_KEY = 'markchat_verification_pending';

export function readPendingRegistrationPayment(
  storage = registrationStore()
): PendingRegistrationPayment | null {
  try {
    const value = JSON.parse(storage?.getItem(PAYMENT_KEY) || 'null');
    if (
      typeof value?.registrationId === 'string' &&
      value.registrationId &&
      typeof value.reference === 'string' &&
      /^[a-zA-Z0-9_-]{8,100}$/.test(value.reference) &&
      Number.isFinite(value.createdAt) &&
      value.createdAt <= Date.now() &&
      Date.now() - value.createdAt < 24 * 60 * 60 * 1000 &&
      (value.purpose === 'account_verification' || value.purpose === 'subscription') &&
      Number.isSafeInteger(value.amountKesCents) &&
      value.amountKesCents > 0
    )
      return value;
  } catch {
    /* A missing or malformed reference cannot confirm a payment. */
  }
  return null;
}

export function savePendingRegistrationPayment(
  value: Omit<PendingRegistrationPayment, 'createdAt'>,
  storage = registrationStore()
): void {
  if (!storage)
    throw new RegistrationError('Enable browser session storage before continuing to payment.');
  storage.setItem(
    PAYMENT_KEY,
    JSON.stringify({
      registrationId: value.registrationId,
      reference: value.reference,
      purpose: value.purpose,
      amountKesCents: value.amountKesCents,
      createdAt: Date.now(),
    })
  );
}

export function clearPendingRegistrationPayment(storage = registrationStore()): void {
  try {
    storage?.removeItem(PAYMENT_KEY);
  } catch {
    /* Server payment state remains authoritative. */
  }
}
