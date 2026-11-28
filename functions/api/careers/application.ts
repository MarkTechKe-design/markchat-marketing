import {
  applicationId,
  invalid,
  missing,
  requireCareersAdmin,
  statuses,
  unavailable,
} from '../../../src/lib/server/careers-admin.ts';
import {
  httpJson,
  readJson,
  sameOrigin,
  type EdgeContext,
} from '../../../src/lib/server/edge-security.ts';

export async function onRequestPatch(context: EdgeContext, id: string): Promise<Response> {
  const denial = await requireCareersAdmin(context);
  if (denial) return denial;
  if (!sameOrigin(context.request))
    return httpJson({ success: false, error: 'Invalid origin.' }, 403);
  if (!applicationId.test(id)) return invalid();
  let body: unknown;
  try {
    body = await readJson(context.request, 1024);
  } catch {
    return invalid();
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Object.keys(body).length !== 1 ||
    !('status' in body) ||
    !statuses.some((s) => s === body.status)
  )
    return invalid();
  try {
    const result = await context.env.MARKCHAT_RATE_DB?.prepare(
      'UPDATE markchat_career_applications SET status=? WHERE id=?'
    )
      .bind(String(body.status), id)
      .run();
    if (result?.success !== true) return unavailable();
    if (result.meta?.changes === 0) return missing();
    return result.meta?.changes === 1
      ? httpJson({ success: true, id, status: body.status })
      : unavailable();
  } catch {
    return unavailable();
  }
}
