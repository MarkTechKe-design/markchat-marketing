import {
  httpJson,
  readBoundedBytes,
  safeText,
  trustedHttpsBase,
  type EdgeContext,
} from './edge-security.ts';

export const statuses = ['new', 'shortlisted', 'interview', 'rejected', 'hired'] as const;
export const applicationId = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
export const unavailable = () =>
  httpJson({ success: false, error: 'Service temporarily unavailable.' }, 503);
export const invalid = () => httpJson({ success: false, error: 'Invalid request.' }, 400);
export const missing = () => httpJson({ success: false, error: 'Application not found.' }, 404);

export function cmsEndpoint(base: string | undefined, path: string): URL | null {
  const url = trustedHttpsBase(base);
  if (!url) return null;
  url.pathname = url.pathname.replace(/\/+$/, '') + path;
  return url;
}

export async function requireCareersAdmin({ request, env }: EdgeContext): Promise<Response | null> {
  const raw = request.headers.get('Authorization');
  let token = raw?.match(/^Bearer ([^\s,]+)$/i)?.[1];
  if (!raw) {
    const match = request.headers.get('Cookie')?.match(/(?:^|;\s*)markchat_admin_token=([^;]+)/);
    try {
      token = match ? decodeURIComponent(match[1]) : undefined;
    } catch {
      token = undefined;
    }
  }
  if (!token || !/^[\x21-\x7e]{1,8192}$/.test(token) || token === env.CMS_SERVICE_TOKEN)
    return httpJson({ success: false, error: 'Sign in required.' }, 401);
  const url = cmsEndpoint(env.CMS_API_BASE_URL, '/api/admin/cms/applications');
  if (!url) return unavailable();
  url.searchParams.set('limit', '1');
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        'Cache-Control': 'no-store',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(7000),
    });
    if (response.status === 401 || response.status === 403)
      return httpJson({ success: false, error: 'Access denied.' }, response.status);
    if (
      !response.ok ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') || '')
    )
      return unavailable();
    const bytes = await readBoundedBytes(response, 128 * 1024);
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      !Array.isArray(data) ||
      !data.every(
        (row) =>
          row &&
          typeof row === 'object' &&
          safeText(row.id, 180, true) &&
          safeText(row.careerId, 180, true)
      )
    )
      return unavailable();
    return null;
  } catch {
    return unavailable();
  }
}
