import {
  applicationId,
  invalid,
  missing,
  unavailable,
} from '../../../src/lib/server/careers-admin.ts';
import {
  httpJson,
  readBoundedBytes,
  type EdgeContext,
} from '../../../src/lib/server/edge-security.ts';
import { MAX_CV_BYTES } from '../../../src/lib/server/career-cv.ts';

type ScanVerdict = 'clean' | 'infected' | 'scan_failed';
interface PendingCv {
  cv_key: string;
  cv_size: number;
  scan_status: string;
}

function bytesHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

async function authenticatedPayload(
  context: EdgeContext,
  id: string
): Promise<{ status: ScanVerdict; sha256: string } | null> {
  const secret = context.env.CAREERS_SCAN_WEBHOOK_SECRET;
  if (!secret || secret.length < 32) return null;
  const timestamp = context.request.headers.get('X-MarkChat-Scan-Timestamp');
  const signature = context.request.headers.get('X-MarkChat-Scan-Signature');
  if (
    !timestamp ||
    !/^[1-9]\d{9}$/.test(timestamp) ||
    !signature ||
    !/^sha256=[a-f0-9]{64}$/i.test(signature) ||
    !/^application\/json(?:;|$)/i.test(context.request.headers.get('Content-Type') || '')
  )
    return null;
  const epoch = Number(timestamp);
  if (Math.abs(Math.floor(Date.now() / 1000) - epoch) > 300) return null;
  let raw: Uint8Array;
  try {
    raw = await readBoundedBytes(context.request, 1024);
  } catch {
    return null;
  }
  if (!raw.length) return null;
  // Sign the exact raw request body, timestamp, and UUID. Do not sign parsed
  // JSON or let request body normalization change the signed message.
  const prefix = new TextEncoder().encode(timestamp + '\n' + id + '\n');
  const message = new Uint8Array(prefix.length + raw.length);
  message.set(prefix);
  message.set(raw, prefix.length);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const hex = signature.slice(7).toLowerCase();
  const signatureBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    signatureBytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  if (!(await crypto.subtle.verify('HMAC', key, signatureBytes, message))) return null;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const fields = body as Record<string, unknown>;
  if (
    Object.keys(fields).length !== 2 ||
    !Object.hasOwn(fields, 'status') ||
    !Object.hasOwn(fields, 'sha256') ||
    !['clean', 'infected', 'scan_failed'].includes(String(fields.status)) ||
    typeof fields.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(fields.sha256)
  )
    return null;
  return { status: fields.status as ScanVerdict, sha256: fields.sha256.toLowerCase() };
}

/**
 * Internal scanner callback. Authentication is a server-only HMAC; a public
 * applicant, recruiter session or CMS_SERVICE_TOKEN can never promote CVs.
 * A scanner MUST actually run an independent malware engine before signing.
 */
export async function onRequestPost(context: EdgeContext, id: string): Promise<Response> {
  if (!applicationId.test(id)) return invalid();
  // Fail closed when scanner integration has not been provisioned.
  if (
    !context.env.CAREERS_SCAN_WEBHOOK_SECRET ||
    context.env.CAREERS_SCAN_WEBHOOK_SECRET.length < 32
  ) {
    return unavailable();
  }
  const verdict = await authenticatedPayload(context, id);
  if (!verdict) return httpJson({ success: false, error: 'Scanner authentication failed.' }, 401);
  const db = context.env.MARKCHAT_RATE_DB;
  const bucket = context.env.MARKCHAT_CAREERS_BUCKET;
  if (!db || !bucket) return unavailable();
  try {
    const row = await db
      .prepare('SELECT cv_key, cv_size, scan_status FROM markchat_career_applications WHERE id=?')
      .bind(id)
      .first<PendingCv>();
    if (!row) return missing();
    if (row.scan_status !== 'pending') {
      return httpJson({ success: false, error: 'Scan verdict already finalized.' }, 409);
    }
    if (
      !Number.isSafeInteger(row.cv_size) ||
      row.cv_size < 1 ||
      row.cv_size > MAX_CV_BYTES ||
      !new RegExp('^(?:quarantine/)?applications/' + id + '/cv\\.(?:pdf|doc|docx)$', 'i').test(
        row.cv_key
      )
    )
      return unavailable();

    const file = await bucket.get(row.cv_key);
    if (!file) return unavailable();
    const bytes = await readBoundedBytes({ headers: new Headers(), body: file.body }, MAX_CV_BYTES);
    if (bytes.byteLength !== row.cv_size) return unavailable();
    const digest = bytesHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
    if (digest !== verdict.sha256) {
      // A signed verdict cannot authorize a different or later R2 object.
      console.warn('CAREERS_SCAN_DIGEST_MISMATCH');
      return httpJson({ success: false, error: 'CV digest mismatch.' }, 409);
    }

    let releasedKey: string | undefined;
    if (verdict.status === 'clean') {
      const extension = row.cv_key.split('.').pop()!.toLowerCase();
      releasedKey = 'clean/applications/' + id + '/cv.' + extension;
      const copied = await bucket.put(releasedKey, bytes);
      if (copied?.key !== releasedKey) {
        console.warn('CAREERS_SCAN_COPY_UNCONFIRMED');
        return unavailable();
      }
    }

    const targetKey = releasedKey || row.cv_key;
    const update = await db
      .prepare(
        "UPDATE markchat_career_applications SET scan_status=?, cv_key=? WHERE id=? AND scan_status='pending' AND cv_key=?"
      )
      .bind(verdict.status, targetKey, id, row.cv_key)
      .run();
    if (update.success !== true || update.meta?.changes !== 1) {
      // Keep all objects when the database acknowledgement is ambiguous.
      // The clean copy cannot be downloaded without the exact D1 transition.
      console.warn('CAREERS_SCAN_TRANSITION_UNCONFIRMED');
      return unavailable();
    }

    if (releasedKey) {
      try {
        await bucket.delete(row.cv_key);
      } catch {
        // A surviving quarantined copy remains private; never downgrade the
        // confirmed released record or delete it due to cleanup failure.
        console.warn('CAREERS_SCAN_QUARANTINE_CLEANUP_FAILED');
      }
    }
    return httpJson({ success: true, id, scanStatus: verdict.status });
  } catch {
    console.warn('CAREERS_SCAN_CALLBACK_FAILED');
    return unavailable();
  }
}
