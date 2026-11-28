import {
  applicationId,
  invalid,
  requireCareersAdmin,
  statuses,
  unavailable,
} from '../../../src/lib/server/careers-admin.ts';
import { httpJson, safeText, type EdgeContext } from '../../../src/lib/server/edge-security.ts';

export async function onRequestGet(context: EdgeContext): Promise<Response> {
  const denial = await requireCareersAdmin(context);
  if (denial) return denial;
  const db = context.env.MARKCHAT_RATE_DB;
  if (!db) return unavailable();
  const query = new URL(context.request.url).searchParams;
  const search = safeText(query.get('search') ?? '', 120);
  const status = query.get('status') || '',
    id = query.get('id') || '';
  const rawLimit = query.get('limit') ?? '25',
    rawOffset = query.get('offset') ?? '0';
  const limit = Number(rawLimit),
    offset = Number(rawOffset);
  if (
    search === null ||
    (id && !applicationId.test(id)) ||
    (status && !statuses.some((s) => s === status)) ||
    !/^\d+$/.test(rawLimit) ||
    !/^\d+$/.test(rawOffset) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset)
  )
    return invalid();
  const filters: string[] = [],
    args: string[] = [];
  if (id) {
    filters.push('id=?');
    args.push(id);
  }
  if (status) {
    filters.push('status=?');
    args.push(status);
  }
  if (search) {
    filters.push(
      '(instr(lower(full_name), lower(?))>0 OR instr(lower(email), lower(?))>0 OR instr(lower(career_title),lower(?))>0 OR instr(lower(specialization),lower(?))>0)'
    );
    args.push(search, search, search, search);
  }
  const from =
    ' FROM markchat_career_applications' +
    (filters.length ? ' WHERE ' + filters.join(' AND ') : '');
  const columns =
    'id,career_id AS careerId,career_title AS careerTitle,full_name AS fullName,email,phone,location,linkedin_url AS linkedinUrl,github_url AS githubUrl,portfolio_url AS portfolioUrl,cover_letter AS coverLetter,consent_agreed AS consentAgreed,submitted_at AS submittedAt,status,specialization,cv_filename AS cvFilename,cv_size AS cvSize,cv_mime AS cvMime,scan_status AS scanStatus,notification_sent AS notificationSent';
  try {
    const count = await db
      .prepare('SELECT COUNT(*) AS total' + from)
      .bind(...args)
      .first<{ total: number }>();
    const result = await db
      .prepare('SELECT ' + columns + from + ' ORDER BY submitted_at DESC,id DESC LIMIT ? OFFSET ?')
      .bind(...args, limit, offset)
      .all<Record<string, unknown>>();
    if (!count || result.success !== true) return unavailable();
    const applications = result.results.map((row) => ({
      ...row,
      hasCv: row.scanStatus === 'clean',
      notificationSent: row.notificationSent === 1,
      consentAgreed: row.consentAgreed === 1,
    }));
    return httpJson({ success: true, applications, total: count.total, limit, offset });
  } catch {
    return unavailable();
  }
}
