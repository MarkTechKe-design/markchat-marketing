import {
  httpJson,
  readJson,
  sameOrigin,
  trustedHttpsBase,
  type EdgeContext,
} from '../../src/lib/server/edge-security.ts';

function upstreamUrl(context: EdgeContext, suffix: string): URL | null {
  const base = trustedHttpsBase(context.env.CONTROL_PLANE_API_URL);
  return base ? new URL('/api/public/careers/' + suffix, base) : null;
}

async function fetchUpstream(url: URL, options: RequestInit = {}): Promise<Response> {
  return fetch(url.toString(), {
    redirect: 'error',
    signal: AbortSignal.timeout(options.method === 'POST' ? 30_000 : 3_000),
    ...options,
  });
}

export async function listPublicRoles(context: EdgeContext): Promise<Response> {
  const url = upstreamUrl(context, 'roles');
  if (!url) return httpJson({ success: true, roles: [] });
  try {
    const response = await fetchUpstream(url);
    if (!response.ok) throw new Error('Roles backend unavailable');
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid response');
    const obj = raw as Record<string, unknown>;
    if (obj.success !== true || !Array.isArray(obj.roles)) throw new Error('Invalid roles');
    return httpJson({ success: true, roles: obj.roles.slice(0, 100) });
  } catch {
    return httpJson({ success: true, roles: [] });
  }
}

export async function getPublicRole(context: EdgeContext, slug: string): Promise<Response> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 160) {
    return httpJson({ success: false, error: 'Position unavailable' }, 404);
  }
  const url = upstreamUrl(context, 'roles/' + encodeURIComponent(slug));
  if (!url) return httpJson({ success: false, error: 'Position unavailable' }, 404);
  try {
    const response = await fetchUpstream(url);
    if (!response.ok) return httpJson({ success: false, error: 'Position unavailable' }, 404);
    const obj: unknown = await response.json();
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Invalid role');
    const result = obj as Record<string, unknown>;
    if (result.success !== true || !result.role || typeof result.role !== 'object') {
      throw new Error('Invalid role');
    }
    return httpJson({ success: true, role: result.role });
  } catch {
    return httpJson({ success: false, error: 'Position unavailable' }, 404);
  }
}

export async function submitApplication(context: EdgeContext): Promise<Response> {
  if (!sameOrigin(context.request)) return httpJson({ success: false, error: 'Forbidden' }, 403);
  const url = upstreamUrl(context, 'apply');
  if (!url) return httpJson({ success: false, error: 'Applications unavailable' }, 503);
  let data: unknown;
  try {
    data = await readJson(context.request, 7_300_000);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid application');
  } catch {
    return httpJson({ success: false, error: 'Invalid application or document size' }, 400);
  }
  try {
    const response = await fetchUpstream(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: new URL(context.request.url).origin,
      },
      body: JSON.stringify(data),
    });
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 201 && body && typeof body === 'object' &&
        !Array.isArray(body) && (body as Record<string, unknown>).success === true &&
        typeof (body as Record<string, unknown>).id === 'string') {
      return httpJson(body, 201);
    }
    if (response.status === 403 || response.status === 400 || response.status === 413 ||
        response.status === 429) {
      return httpJson({ success: false, error: 'Applications are closed or the submission was invalid' },
        response.status);
    }
    return httpJson({ success: false, error: 'Application could not be confirmed' }, 503);
  } catch {
    return httpJson({ success: false, error: 'Application service unavailable' }, 503);
  }
}
