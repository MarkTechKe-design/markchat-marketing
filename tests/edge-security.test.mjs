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
const fakeD1 = (attempts = 1) => ({
  prepare: () => ({ bind: () => ({ first: async () => ({ attempts }) }) }),
});

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

test('lead success is conditional on explicit persistence confirmation', async () => {
  const previousFetch = globalThis.fetch;
  let received;
  try {
    globalThis.fetch = async (_url, options) => {
      received = JSON.parse(options.body);
      return Response.json({ success: false }, { status: 201 });
    };
    const env = {
      MARKCHAT_RATE_DB: fakeD1(),
      RATE_HASH_SECRET,
      CMS_API_BASE_URL: 'https://cms.example.co.ke',
    };
    const failed = await submitLead({ request: request('/api/leads', validLead()), env });
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).success, false);
    assert.match(received.adminReplyMailto, /^mailto:/);

    globalThis.fetch = async () => Response.json({ success: true }, { status: 201 });
    const success = await submitLead({ request: request('/api/leads', validLead()), env });
    const json = await success.json();
    assert.equal(success.status, 201);
    assert.equal(json.success, true);
    assert.equal(json.notificationSent, false);
    assert.ok(
      !('adminReplyMailto' in json),
      'Do not disclose admin reply payload in public response'
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Gemini receives vetted public facts when CMS and Control Plane are unavailable', async () => {
  const previousFetch = globalThis.fetch;
  let called;
  try {
    globalThis.fetch = async (url, options) => {
      called = { url: String(url), headers: options.headers, body: JSON.parse(options.body) };
      return Response.json({
        candidates: [
          {
            content: { parts: [{ text: 'MarkChat offers team inbox tools for customer support.' }] },
          },
        ],
      });
    };
    const response = await askAssistant({
      request: request('/api/markcopilot', { question: 'What does MarkChat do?' }),
      env: {
        MARKCHAT_RATE_DB: fakeD1(),
        RATE_HASH_SECRET,
        GEMINI_API_KEY: 'test-only-gemini-key',
      },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.mode, 'live');
    assert.match(called.url, /gemini-2\.5-flash:generateContent$/);
    assert.equal(called.headers['x-goog-api-key'], 'test-only-gemini-key');
    const instruction = called.body.systemInstruction.parts[0].text;
    assert.match(instruction, /publicProductBasics/);
    assert.match(instruction, /No subscription prices may be quoted without published plan data/);
    assert.ok(!JSON.stringify(body).includes('test-only-gemini-key'));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('assistant never sends contact details or credentials to external AI', async () => {
  const previousFetch = globalThis.fetch;
  let requests = 0;
  try {
    globalThis.fetch = async () => {
      requests++;
      throw new Error('External AI should not receive this request');
    };
    const response = await askAssistant({
      request: request('/api/markcopilot', { question: 'Email me at buyer@example.com' }),
      env: {
        MARKCHAT_RATE_DB: fakeD1(),
        RATE_HASH_SECRET,
        GEMINI_API_KEY: 'test-only-gemini-key',
      },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.mode, 'guide');
    assert.match(body.answer, /do not share personal details/i);
    assert.equal(requests, 0);
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
  assert.match(lead, /success === true/);
  assert.match(ai, /productGuide/);
});
