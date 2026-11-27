import {
  httpJson,
  enforceRate,
  readBoundedBytes,
  sameOrigin,
  type EdgeContext,
} from '../../../src/lib/server/edge-security.ts';
import { invalid, unavailable } from '../../../src/lib/server/careers-admin.ts';
import {
  applicationFields,
  notifyRecruiter,
  roleTitle,
} from '../../../src/lib/server/careers-submit.ts';
import { MAX_CV_BYTES, validateCareerCv } from '../../../src/lib/server/career-cv.ts';

export async function onRequestPost(context: EdgeContext): Promise<Response> {
  const { request, env } = context;
  if (!sameOrigin(request)) return httpJson({ success: false, error: 'Invalid origin.' }, 403);
  const type = request.headers.get('Content-Type') || '';
  if (!/^multipart\/form-data\s*;/i.test(type))
    return httpJson({ success: false, error: 'Upload a multipart application.' }, 415);
  const rate = await enforceRate(context, 'careers_apply');
  if (rate) return rate;
  const bucket = env.MARKCHAT_CAREERS_BUCKET,
    db = env.MARKCHAT_RATE_DB;
  if (!bucket || !db) return unavailable();
  let form: FormData;
  try {
    const body = await readBoundedBytes(request, MAX_CV_BYTES + 65536);
    form = await new Response(body, { headers: { 'Content-Type': type } }).formData();
  } catch (err) {
    return err instanceof Error && err.message === 'Too large'
      ? httpJson({ success: false, error: 'Application exceeds the upload limit.' }, 413)
      : invalid();
  }
  const data = applicationFields(form);
  if (!data) return invalid();
  if (data.cv.size > MAX_CV_BYTES)
    return httpJson({ success: false, error: 'CV exceeds the upload limit.' }, 413);
  let cv;
  try {
    cv = await validateCareerCv(data.cv);
  } catch {
    return invalid();
  }
  if (!cv) return httpJson({ success: false, error: 'Upload a valid PDF, DOC, or DOCX CV.' }, 400);
  const id = crypto.randomUUID(),
    key = 'applications/' + id + '/cv.' + cv.extension;
  let title: string | null;
  try {
    title = await roleTitle(data.careerId, env);
  } catch {
    return unavailable();
  }
  if (!title) return httpJson({ success: false, error: 'Role unavailable.' }, 400);
  try {
    const uploaded = await bucket.put(key, cv.bytes);
    if (uploaded?.key !== key) throw new Error('Unconfirmed CV upload');
    const result = await db
      .prepare(
        `INSERT INTO markchat_career_applications
      (id,career_id,career_title,full_name,email,phone,location,specialization,linkedin_url,github_url,portfolio_url,cover_letter,consent_agreed,submitted_at,cv_key,cv_filename,cv_mime,cv_size)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`
      )
      .bind(
        id,
        data.careerId,
        title,
        data.fullName,
        data.email,
        data.phone,
        data.location,
        data.specialization,
        data.linkedinUrl,
        data.githubUrl,
        data.portfolioUrl,
        data.coverLetter,
        new Date().toISOString(),
        key,
        cv.filename,
        cv.mime,
        cv.bytes.byteLength
      )
      .run();
    if (result.success !== true || result.meta?.changes !== 1)
      throw new Error('Unconfirmed insert');
  } catch {
    // A failed acknowledgement can follow a committed INSERT. Direct D1
    // queries (without a read-replica session) read from the primary.
    try {
      const row = await db
        .prepare('SELECT id FROM markchat_career_applications WHERE id=? AND cv_key=?')
        .bind(id, key)
        .first<{ id: string }>();
      if (row !== null) {
        console.warn('CAREERS_INSERT_ACK_UNCONFIRMED');
        return unavailable();
      }
    } catch {
      console.warn('CAREERS_INSERT_RECONCILIATION_UNAVAILABLE');
      return unavailable();
    }
    try {
      await bucket.delete(key);
      console.warn('CAREERS_APPLICATION_NOT_PERSISTED');
    } catch {
      console.warn('CAREERS_CV_ROLLBACK_UNCONFIRMED');
    }
    return unavailable();
  }
  const dashboard = new URL('/dashboard/careers', request.url);
  dashboard.searchParams.set('application', id);
  try {
    await notifyRecruiter(env, id, title, data, dashboard);
  } catch {
    console.warn('CAREERS_NOTIFICATION_UNCONFIRMED');
  }
  return httpJson({ success: true, id, message: 'Application received.' }, 201);
}
