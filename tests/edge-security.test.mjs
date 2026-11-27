import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  adminReplyMailto,
  kenyaPhone,
  parseLead,
  safeSourcePage,
  validEmail,
} from '../src/lib/server/edge-security.ts';
import { productGuide } from '../src/lib/server/marketing-truth.ts';
import { onRequestPost as submitLead } from '../functions/api/leads.ts';
import { onRequestPost as askAssistant } from '../functions/api/markcopilot.ts';

const validLead = () => ({
  name: 'Sample Customer',
  email: 'customer@example.co.ke',
  phone: '+254712345678',
  businessName: 'Example Retail',
  interest: 'Product demonstration',
  transcriptSummary: 'Customer asks about a demo.',
  sourcePage: '/features',
  startedAt: Date.now() - 3500,
  consent: true,
  website: '',
});
const request = (route, value, headers = {}) =>
  new Request('https://markchat.co.ke' + route, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://markchat.co.ke',
      'CF-Connecting-IP': '203.0.113.8',
      'Sec-Fetch-Site': 'same-origin',
      ...headers,
    },
    body: JSON.stringify(value),
  });
const RATE_HASH_SECRET = 'test-only-random-key-32-chars-long-0001';
const fakeD1 = (attempts = 1, insertSuccess = true) => {
  const db = {
    writes: [],
    prepare(sql) {
      return {
        bind(...params) {
          return {
            first: async () => ({ attempts }),
            run: async () => {
              db.writes.push({ sql, params });
              const success = sql.includes('INSERT INTO markchat_leads') ? insertSuccess : true;
              return { success, meta: { changes: success ? 1 : 0 } };
            },
          };
        },
      };
    },
  };
  return db;
};

test('edge lead validation rejects malformed content, injections and bots', () => {
  assert.equal(kenyaPhone('0712 345 678'), '+254712345678');
  assert.equal(kenyaPhone('254712345678'), '+254712345678');
  assert.equal(kenyaPhone('12345'), null);
  assert.equal(validEmail('a@example.co.ke\r\nBCC:evil@example.com'), null);
  assert.equal(validEmail('a%0A@example.co.ke'), null);
  assert.equal(safeSourcePage('//evil.test'), null);
  assert.equal(parseLead({ ...validLead(), consent: false }), null);
  assert.equal(parseLead({ ...validLead(), website: 'spam' }), null);
  assert.equal(parseLead({ ...validLead(), startedAt: Date.now() }), null);
  assert.equal(parseLead({ ...validLead(), email: 'bad\r\nCc: injected' }), null);
  assert.equal(parseLead({ ...validLead(), transcriptSummary: 'x'.repeat(2000) }), null);
  assert.ok(parseLead(validLead()));
  assert.equal(
    parseLead({ ...validLead(), monthlyVolume: '1,000 messages' })?.monthlyVolume,
    '1,000 messages'
  );
});

test('reply mailto URL encodes context and never admits header newlines', () => {
  const result = adminReplyMailto(validLead());
  assert.match(result, /^mailto:customer@example.co.ke\?/);
  assert.match(result, /subject=/);
  assert.ok(!result.includes('\r') && !result.includes('\n'));
  assert.throws(() => adminReplyMailto({ ...validLead(), email: 'bad\r\nBCC:evil@example.com' }));
});

test('public edge endpoints reject cross-site and unavailable rate-limit services', async () => {
  const crossOrigin = request('/api/leads', validLead(), { Origin: 'https://attacker.test' });
  assert.equal((await submitLead({ request: crossOrigin, env: {} })).status, 403);
  assert.equal(
    (await submitLead({ request: request('/api/leads', validLead()), env: {} })).status,
    503
  );
  assert.equal(
    (
      await askAssistant({
        request: request('/api/markcopilot', { question: 'What is M-Pesa?' }),
        env: { MARKCHAT_RATE_DB: fakeD1(100), RATE_HASH_SECRET },
      })
    ).status,
    429
  );
});

test('D1 must confirm one lead INSERT before returning success', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('Email must not be sent without config'); };
    const db = fakeD1();
    const success = await submitLead({
      request: request('/api/leads', validLead()),
      env: { MARKCHAT_RATE_DB: db, RATE_HASH_SECRET },
    });
    const body = await success.json();
    assert.equal(success.status, 201);
    assert.equal(body.success, true);
    assert.equal(body.notificationSent, false);
    assert.equal(db.writes.length, 1);
    assert.match(db.writes[0].sql, /INSERT INTO markchat_leads/);
    assert.equal(db.writes[0].params.length, 12);
    assert.equal(db.writes[0].params[3], 'Sample Customer');
    assert.ok(!('adminReplyMailto' in body));

    const failedDb = fakeD1(1, false);
    const missing = await submitLead({
      request: request('/api/leads', validLead()),
      env: {
        MARKCHAT_RATE_DB: failedDb,
        RATE_HASH_SECRET,
        RESEND_API_KEY: 'test-only',
        RESEND_FROM_EMAIL: 'leads@example.co.ke',
      },
    });
    assert.equal(missing.status, 502);
    assert.equal((await missing.json()).success, false);
    assert.equal(failedDb.writes.length, 1, 'Resend must never run after failed INSERT');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Resend notification and D1 notification flag follow a confirmed save', async () => {
  const previousFetch = globalThis.fetch;
  const sent = [];
  try {
    globalThis.fetch = async (url, opts) => {
      sent.push({ url: String(url), body: JSON.parse(opts.body) });
      return Response.json({ id: 'test-resend-id' }, { status: 200 });
    };
    const db = fakeD1();
    const res = await submitLead({
      request: request('/api/leads', validLead()),
      env: {
        MARKCHAT_RATE_DB: db,
        RATE_HASH_SECRET,
        RESEND_API_KEY: 'test-only',
        RESEND_FROM_EMAIL: 'leads@example.co.ke',
      },
    });
    const payload = await res.json();
    assert.equal(res.status, 201);
    assert.equal(payload.success, true);
    assert.equal(payload.notificationSent, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://api.resend.com/emails');
    assert.equal(sent[0].body.reply_to, 'customer@example.co.ke');
    assert.equal(db.writes.length, 2);
    assert.match(db.writes[1].sql, /^UPDATE markchat_leads SET notification_sent/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('deterministic Product Guide never fabricates prices or claims fund custody', () => {
  const unknown = productGuide('Compare KES pricing plans', {
    plans: [],
    features: [],
    authoritative: false,
  });
  assert.match(unknown, /not available/i);
  assert.doesNotMatch(unknown, /KES 1,500|3,500|5,000/i);
  const published = productGuide('Compare KES pricing plans', {
    plans: [{ name: 'Example Plan', priceKes: 1999, features: [] }],
    features: [],
    authoritative: true,
  });
  assert.match(published, /KES 1,999/);
  assert.doesNotMatch(published, /escrow/i);
});

test('widget never interpolates user or AI messages into innerHTML or bundles secrets', () => {
  const widget = readFileSync('src/components/common/MarkcopilotWidget.astro', 'utf8');
  const lead = readFileSync('functions/api/leads.ts', 'utf8');
  const ai = readFileSync('functions/api/markcopilot.ts', 'utf8');
  assert.doesNotMatch(
    widget,
    /innerHTML|GEMINI_API_KEY|OPENAI_API_KEY|RESEND_API_KEY|CMS_SERVICE_TOKEN/
  );
  assert.match(widget, /\.textContent/);
  assert.match(widget, /Escape/);
  assert.match(widget, /75dvh/);
  assert.match(widget, /Product Guide/);
  assert.match(lead, /result\.success === true/);
  assert.match(ai, /productGuide/);
});
