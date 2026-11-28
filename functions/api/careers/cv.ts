import {
  applicationId,
  invalid,
  missing,
  requireCareersAdmin,
  unavailable,
} from '../../../src/lib/server/careers-admin.ts';
import { httpJson, type EdgeContext } from '../../../src/lib/server/edge-security.ts';

export async function onRequestGet(context: EdgeContext, id: string): Promise<Response> {
  const denial = await requireCareersAdmin(context);
  if (denial) return denial;
  if (!applicationId.test(id)) return invalid();
  const { MARKCHAT_RATE_DB: db, MARKCHAT_CAREERS_BUCKET: bucket } = context.env;
  if (!db || !bucket) return unavailable();
  try {
    const row = await db
      .prepare('SELECT cv_key,cv_filename,cv_mime,scan_status FROM markchat_career_applications WHERE id=?')
      .bind(id)
      .first<{ cv_key: string; cv_filename: string; cv_mime: string; scan_status: string }>();
    if (!row) return missing();
    if (
      row.scan_status !== 'clean' ||
      !new RegExp('^clean/applications/' + id + '/cv\\.(?:pdf|doc|docx)
    if (!file) return unavailable();
    const name = row.cv_filename.replace(/[^a-zA-Z0-9._ -]/g, '_');
    return new Response(file.body, {
      headers: {
        'Content-Type': row.cv_mime,
        'Content-Disposition': 'attachment; filename="' + name + '"',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch {
    return unavailable();
  }
}
, 'i').test(row.cv_key)
    ) {
      return httpJson({ success: false, error: 'CV is not cleared for download.' }, 423);
    }
    const file = await bucket.get(row.cv_key);
    if (!file) return unavailable();
    const name = row.cv_filename.replace(/[^a-zA-Z0-9._ -]/g, '_');
    return new Response(file.body, {
      headers: {
        'Content-Type': row.cv_mime,
        'Content-Disposition': 'attachment; filename="' + name + '"',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch {
    return unavailable();
  }
}
