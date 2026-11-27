/**
 * Shared Cloudflare Pages Functions contracts. Never import this module
 * into a client Astro script with a secret binding.
 */
export interface D1RateDatabase {
  prepare(sql: string): {
    bind(...args: (string | number)[]): {
      first<T>(): Promise<T | null>;
    };
  };
}
export interface EdgeEnv {
  MARKCHAT_RATE_DB?: D1RateDatabase;
  CMS_API_BASE_URL?: string;
  CMS_SERVICE_TOKEN?: string;
  CONTROL_PLANE_API_URL?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  ADMIN_NOTIFICATION_WEBHOOK_URL?: string;
  ADMIN_NOTIFICATION_WEBHOOK_TOKEN?: string;
  AI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  AI_API_BASE_URL?: string;
  AI_MODEL?: string;
}
export interface EdgeContext {
  request: Request;
  env: EdgeEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
}
export interface LeadInput {
  name: string;
  email: string;
  phone: string;
  businessName: string;
  interest: string;
  transcriptSummary: string;
  sourcePage: string;
  startedAt: number;
  consent: true;
  website: string;
}
const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const REPLY_TARGET = 'hello@markchat.co.ke';
export function safeText(value: unknown, max: number, required = false): string | null {
  if (typeof value !== 'string') return required ? null : '';
  const clean = value.trim();
  if (clean.length > max || CONTROL_CHARS.test(clean) || (required && !clean)) return null;
  return clean;
}
export function validEmail(value: unknown): string | null {
  const email = safeText(value, 254, true);
  if (!email || !EMAIL_PATTERN.test(email)) return null;
  return email.toLowerCase();
}
export function kenyaPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/[\s-]/g, '').trim();
  const normalized = /^0[17]\d{8}$/.test(digits)
    ? '+254' + digits.slice(1)
    : /^254[17]\d{8}$/.test(digits)
      ? '+' + digits
      : digits;
  return /^\+254[17]\d{8}$/.test(normalized) ? normalized : null;
}
export function safeSourcePage(value: unknown): string | null {
  const path = safeText(value, 180, true);
  if (!path || !/^\/(?!\/)[a-zA-Z0-9/_-]*$/.test(path)) return null;
  return path;
}
export function parseLead(value: unknown, now = Date.now()): LeadInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    'name', 'email', 'phone', 'businessName', 'interest',
    'transcriptSummary', 'sourcePage', 'startedAt', 'consent', 'website',
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
  const name = safeText(raw.name, 100, true);
  const email = validEmail(raw.email);
  const phone = kenyaPhone(raw.phone);
  const businessName = safeText(raw.businessName, 100);
  const interest = safeText(raw.interest, 100, true);
  const transcriptSummary = safeText(raw.transcriptSummary, 1600);
  const sourcePage = safeSourcePage(raw.sourcePage);
  const website = safeText(raw.website, 100);
  const startedAt = raw.startedAt;
  if (!name || !email || !phone || businessName === null || !interest ||
    transcriptSummary === null || !sourcePage || website === null ||
    website !== '' || raw.consent !== true ||
    typeof startedAt !== 'number' || !Number.isInteger(startedAt) ||
    startedAt > now - 1200 || startedAt < now - 86_400_000) return null;
  return { name, email, phone, businessName, interest, transcriptSummary, sourcePage, startedAt, consent: true, website };
}
export function adminReplyMailto(lead: Pick<LeadInput, 'name' | 'email' | 'businessName' | 'interest' | 'sourcePage'>): string {
  const email = validEmail(lead.email);
  if (!email) throw new Error('Invalid reply email');
  const subject = 'Re: MarkChat inquiry – ' + lead.interest.replace(/[\r\n]/g, ' ').slice(0, 70);
  const body = [
    `Hi ${lead.name},`, '',
    'Thanks for contacting MarkChat™.',
    `Regarding: ${lead.interest}`,
    lead.businessName ? `Business: ${lead.businessName}` : '',
    `Source: ${lead.sourcePage}`, '',
    'Kind regards,', 'MarkChat Team',
  ].filter((line) => line !== undefined).join('\n');
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
export function httpJson(value: unknown, status = 200, extras: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
      'Referrer-Policy': 'no-referrer',
      ...extras,
    },
  });
}
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  const intended = new URL(request.url).origin;
  if (origin !== intended) return false;
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  return true;
}
export async function readJson(request: Request, maxBytes = 12_000): Promise<unknown> {
  const type = request.headers.get('Content-Type') || '';
  if (!/^application\/json(?:;|$)/i.test(type)) throw new Error('Unsupported content type');
  const length = Number(request.headers.get('Content-Length') || '0');
  if (length > maxBytes) throw new Error('Too large');
  const body = await request.text();
  if (new TextEncoder().encode(body).length > maxBytes) throw new Error('Too large');
  return JSON.parse(body);
}
export async function enforceRate(context: EdgeContext, scope: 'chat' | 'lead'): Promise<Response | null> {
  // Cloudflare Pages supports a D1 binding. An atomic upsert prevents
  // in-memory per-isolate bypasses. Fail closed until the D1 table is provisioned.
  const db = context.env.MARKCHAT_RATE_DB;
  if (!db) return httpJson({ success: false, error: 'Service temporarily unavailable.' }, 503);
  const ip = context.request.headers.get('CF-Connecting-IP');
  if (!ip || ip.length > 64) return httpJson({ success: false, error: 'Unable to validate request.' }, 403);
  const fingerprint = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  const key = Array.from(new Uint8Array(fingerprint), (v) => v.toString(16).padStart(2, '0')).join('');
  const windowStart = Math.floor(Date.now() / 60000);
  const max = scope === 'chat' ? 20 : 6;
  try {
    const result = await db.prepare(
      `INSERT INTO markchat_rate_limit (scope, ip_hash, window_start, attempts)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(scope, ip_hash) DO UPDATE SET
         attempts = CASE WHEN window_start < excluded.window_start THEN 1 ELSE attempts + 1 END,
         window_start = CASE WHEN window_start < excluded.window_start THEN excluded.window_start ELSE window_start END
       RETURNING attempts`
    ).bind(scope, key, windowStart).first<{ attempts: number }>();
    if (!result || result.attempts > max) {
      return httpJson({ success: false, error: 'Too many requests. Try again shortly.' }, 429, {
        'Retry-After': '60',
      });
    }
    return null;
  } catch {
    return httpJson({ success: false, error: 'Service temporarily unavailable.' }, 503);
  }
}
export function trustedHttpsBase(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) return null;
    if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) return null;
    return url;
  } catch {
    return null;
  }
}
