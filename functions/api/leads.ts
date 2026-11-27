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
/** A durable lead exists only after D1 confirms an INSERT of one row. */
async function persistLead(
  context: EdgeContext,
  lead: ReturnType<typeof leadEnvelope>
): Promise<boolean> {
  const db = context.env.MARKCHAT_RATE_DB;
  if (!db) {
    console.warn('LEADS_D1_BINDING_MISSING');
    return false;
  }

  try {
    const result = await db
      .prepare(
        `INSERT INTO markchat_leads (
        id, created_at, status, full_name, email, phone, business_name,
        interest, monthly_volume, transcript_summary, source_page, admin_reply_mailto
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        lead.id,
        lead.createdAt,
        lead.status,
        lead.fullName,
        lead.email,
        lead.phone,
        lead.businessName,
        lead.interest,
        lead.monthlyVolume,
        lead.transcriptSummary,
        lead.sourcePage,
        lead.adminReplyMailto
      )
      .run();
    const confirmed = result.success === true && result.meta?.changes === 1;
    if (!confirmed) console.warn('LEADS_D1_INSERT_NOT_CONFIRMED');
    return confirmed;
  } catch {
    // Do not log SQL bound values, customer data or provider secrets.
    console.warn('LEADS_D1_INSERT_FAILED');
    return false;
  }
}

async function flagNotificationDelivered(context: EdgeContext, id: string): Promise<void> {
  const db = context.env.MARKCHAT_RATE_DB;
  if (!db) return;
  try {
    const result = await db
      .prepare('UPDATE markchat_leads SET notification_sent = 1 WHERE id = ?')
      .bind(id)
      .run();
    if (result.success !== true || result.meta?.changes !== 1) {
      console.warn('LEADS_D1_NOTIFICATION_FLAG_UNCONFIRMED');
    }
  } catch {
    console.warn('LEADS_D1_NOTIFICATION_FLAG_FAILED');
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
  // Email is not durable lead storage: never notify or acknowledge until D1
  // confirms the record was actually inserted.
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
  if (notified) await flagNotificationDelivered(context, lead.id);
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
