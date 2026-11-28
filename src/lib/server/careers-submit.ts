import { normalizeCareerLink } from '../careers-links.ts';
import { bundledCareerRoles } from '../careers-published.ts';
import { cmsEndpoint } from './careers-admin.ts';
import { kenyaPhone, safeText, validEmail, type EdgeEnv } from './edge-security.ts';

const allowed = new Set([
  'careerId',
  'careerTitle',
  'specialization',
  'fullName',
  'email',
  'phone',
  'location',
  'linkedinUrl',
  'githubUrl',
  'portfolioUrl',
  'coverLetter',
  'consent',
  'website',
  'startedAt',
  'cv',
]);
function safeMultiline(input: string): boolean {
  return Array.from(input).every(
    (c) => c === '\n' || (c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
  );
}

function link(value: string | File | null): string | null {
  const input = safeText(value, 2048);
  return input === null ? null : normalizeCareerLink(input);
}

export function applicationFields(form: FormData) {
  const seen = new Set<string>();
  for (const [k, v] of form) {
    if (!allowed.has(k) || seen.has(k) || (k !== 'cv' && typeof v !== 'string')) return null;
    seen.add(k);
  }
  const careerId = safeText(form.get('careerId'), 150, true);
  const fullName = safeText(form.get('fullName'), 100, true);
  const email = validEmail(form.get('email'));
  const rawPhone = safeText(form.get('phone'), 32, true);
  const phone =
    kenyaPhone(rawPhone) || (rawPhone && /^\+[1-9]\d{6,14}$/.test(rawPhone) ? rawPhone : null);
  const specialization = safeText(form.get('specialization'), 120, careerId === 'general');
  const location = safeText(form.get('location'), 120);
  const linkedinUrl = link(form.get('linkedinUrl')),
    githubUrl = link(form.get('githubUrl')),
    portfolioUrl = link(form.get('portfolioUrl'));
  const rawLetter = form.get('coverLetter');
  const coverLetter = typeof rawLetter === 'string' ? rawLetter.replace(/\r\n/g, '\n').trim() : '';
  const cv = form.get('cv');
  const startedAt = form.get('startedAt');
  const started = Number(startedAt);
  const now = Date.now();
  if (
    !careerId ||
    !/^[\w-]+$/.test(careerId) ||
    safeText(form.get('careerTitle'), 240) === null ||
    !fullName ||
    !phone ||
    !email ||
    specialization === null ||
    location === null ||
    linkedinUrl === null ||
    githubUrl === null ||
    portfolioUrl === null ||
    coverLetter.length > 4000 ||
    !safeMultiline(coverLetter) ||
    !cv ||
    typeof cv === 'string' ||
    form.get('consent') !== 'true' ||
    form.get('website') !== '' ||
    typeof startedAt !== 'string' ||
    !/^\d{13}$/.test(startedAt) ||
    started > now - 1200 ||
    started < now - 86400000
  )
    return null;
  return {
    careerId,
    fullName,
    email,
    phone,
    specialization,
    location,
    linkedinUrl,
    githubUrl,
    portfolioUrl,
    coverLetter,
    cv,
  };
}

export async function roleTitle(careerId: string, env: EdgeEnv): Promise<string | null> {
  if (careerId === 'general') return 'General Talent Pool';
  if (!env.CMS_API_BASE_URL)
    return Object.hasOwn(bundledCareerRoles, careerId) ? bundledCareerRoles[careerId] : null;
  const url = cmsEndpoint(
    env.CMS_API_BASE_URL,
    '/api/public/careers/' + encodeURIComponent(careerId)
  );
  if (!url) throw new Error('CMS unavailable');
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(6000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('CMS unavailable');
  const role = await res.json();
  return role?.status === 'published' && (role.id === careerId || role.slug === careerId)
    ? safeText(role.title, 240, true)
    : null;
}

type Fields = NonNullable<ReturnType<typeof applicationFields>>;
function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
export async function notifyRecruiter(
  env: EdgeEnv,
  id: string,
  title: string,
  data: Fields,
  dashboard: URL
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) return;
  const lines = [
    'A new careers application was received. CV download remains blocked until malware scanning is complete.',
    'Role: ' + title,
    'Candidate: ' + data.fullName,
    'Email: ' + data.email,
    'Phone: ' + data.phone,
    'Specialization: ' + data.specialization,
    'Location: ' + data.location,
    'LinkedIn: ' + data.linkedinUrl,
    'GitHub: ' + data.githubUrl,
    'Portfolio: ' + data.portfolioUrl,
    'Cover note: ' + data.coverLetter,
  ];
  const result = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'careers-' + id,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(6000),
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: ['hello@markchat.co.ke'],
      reply_to: data.email,
      subject: 'New MarkChat careers application: ' + title,
      text: [...lines, dashboard.href].join('\n'),
      html:
        lines.map((s) => '<p>' + escapeHtml(s).replaceAll('\n', '<br>') + '</p>').join('') +
        '<p><a href="' +
        escapeHtml(dashboard.href) +
        '">Review application</a></p>',
    }),
  });
  if (!result.ok) return;
  const sent = await result.json();
  if (typeof sent?.id !== 'string' || !sent.id.trim()) return;
  try {
    const updated = await env.MARKCHAT_RATE_DB?.prepare(
      'UPDATE markchat_career_applications SET notification_sent=1 WHERE id=?'
    )
      .bind(id)
      .run();
    if (updated?.success === true && updated.meta?.changes === 1) return;
  } catch {
    // Resend accepted the notification but D1 did not confirm its flag.
  }
  console.warn('CAREERS_NOTIFICATION_FLAG_UNCONFIRMED');
}
