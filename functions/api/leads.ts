import {
  adminReplyMailto,
  enforceRate,
  httpJson,
  parseLead,
  readJson,
  sameOrigin,
  trustedHttpsBase,
  type EdgeContext,
} from '../../src/lib/server/edge-security.ts';

function leadEnvelope(input: NonNullable<ReturnType<typeof parseLead>>) {
  const id = crypto.randomUUID();
  const adminReply = adminReplyMailto(input);
  return {
    id,
    createdAt: new Date().toISOString(),
    status: 'new',
    // Existing CMS public-lead contract, retained for dashboard compatibility.
    fullName: input.name,
    email: input.email,
    phone: input.phone,
    company: input.businessName,
    monthlyVolume: input.monthlyVolume || 'Not specified',
    source: 'Markcopilot Widget ' + input.sourcePage,
    message: input.transcriptSummary,
    // Additive metadata. Existing CMS servers may ignore unknown fields.
    businessName: input.businessName,
    interest: input.interest,
    transcriptSummary: input.transcriptSummary,
    sourcePage: input.sourcePage,
    adminReplyMailto: adminReply,
  };
}
async function persistLead(
  context: EdgeContext,
  lead: ReturnType<typeof leadEnvelope>
): Promise<boolean> {
  const base = trustedHttpsBase(context.env.CMS_API_BASE_URL);
  if (!base) return false;
  const url = new URL('/api/public/leads', base);
  // Do not embed server credentials in the lead or return them to the browser.
  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(context.env.CMS_SERVICE_TOKEN
          ? { Authorization: 'Bearer ' + context.env.CMS_SERVICE_TOKEN }
          : {}),
        'Idempotency-Key': lead.id,
      },
      body: JSON.stringify(lead),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
      cache: 'no-store',
    });
    if (response.status !== 200 && response.status !== 201) return false;
    const json: unknown = await response.json();
    return Boolean(
      json && typeof json === 'object' && (json as { success?: unknown }).success === true
    );
  } catch {
    return false;
  }
}
async function notifyAdmin(
  context: EdgeContext,
  lead: ReturnType<typeof leadEnvelope>
): Promise<boolean> {
  if (!context.env.RESEND_API_KEY || !context.env.RESEND_FROM_EMAIL) {
    // An authenticated HTTPS webhook may integrate with a server-side SMTP relay.
    const webhook = trustedHttpsBase(context.env.ADMIN_NOTIFICATION_WEBHOOK_URL);
    if (!webhook || !context.env.ADMIN_NOTIFICATION_WEBHOOK_TOKEN) return false;
    try {
      const result = await fetch(webhook.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + context.env.ADMIN_NOTIFICATION_WEBHOOK_TOKEN,
        },
        body: JSON.stringify({
          to: 'hello@markchat.co.ke',
          replyTo: lead.email,
          name: lead.fullName,
          interest: lead.interest,
          businessName: lead.businessName,
          transcriptSummary: lead.transcriptSummary,
          adminReplyMailto: lead.adminReplyMailto,
        }),
        signal: AbortSignal.timeout(4500),
        redirect: 'error',
        cache: 'no-store',
      });
      return result.status === 200 || result.status === 201 || result.status === 202;
    } catch {
      return false;
    }
  }
  // Require a domain-verified sender address set via Cloudflare server-only secrets.
  if (!/^[^\s@\r\n]+@[^\s@\r\n]+\.[a-z]{2,}$/i.test(context.env.RESEND_FROM_EMAIL)) return false;
  const lines = [
    'New MarkChat™ inquiry',
    'Name: ' + lead.fullName,
    'Email: ' + lead.email,
    'Phone: ' + lead.phone,
    'Business: ' + lead.businessName,
    'Interest: ' + lead.interest,
    'Source page: ' + lead.sourcePage,
    'Summary: ' + lead.transcriptSummary,
    'Reply link: ' + lead.adminReplyMailto,
  ];
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + context.env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: context.env.RESEND_FROM_EMAIL,
        to: ['hello@markchat.co.ke'],
        reply_to: lead.email,
        subject: 'New MarkChat inquiry • ' + lead.interest,
        text: lines.join('\n'),
      }),
      signal: AbortSignal.timeout(4500),
      cache: 'no-store',
      redirect: 'error',
    });
    return response.status === 200 || response.status === 201;
  } catch {
    return false;
  }
}
export async function onRequestPost(context: EdgeContext): Promise<Response> {
  if (!sameOrigin(context.request)) return httpJson({ success: false, error: 'Forbidden' }, 403);
  const blocked = await enforceRate(context, 'lead');
  if (blocked) return blocked;
  let parsed: unknown;
  try {
    parsed = await readJson(context.request, 9000);
  } catch {
    return httpJson({ success: false, error: 'Invalid submission' }, 400);
  }
  const input = parseLead(parsed);
  if (!input) return httpJson({ success: false, error: 'Please check the form fields.' }, 400);

  const lead = leadEnvelope(input);
  const persisted = await persistLead(context, lead);
  if (!persisted) {
    return httpJson(
      {
        success: false,
        error: 'Unable to save your inquiry. Email hello@markchat.co.ke instead.',
      },
      502
    );
  }
  const notified = await notifyAdmin(context, lead);
  return httpJson(
    {
      success: true,
      message: 'Thank you. Your inquiry was saved and our team can follow up.',
      notificationSent: notified,
      id: lead.id,
    },
    201
  );
}
