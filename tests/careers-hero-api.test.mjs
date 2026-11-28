import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet, onRequestPut } from '../functions/api/careers/hero.ts';
const origin = 'https://markchat.co.ke';
function context(method = 'GET', body, result = { success: true, meta: { changes: 1 } }) {
  const calls = [];
  return {
    calls,
    request: new Request(origin + '/api/careers/hero', {
      method,
      headers: {
        Origin: origin,
        Authorization: 'Bearer valid-admin-session',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env: {
      CMS_API_BASE_URL: 'https://cms.example.test',
      MARKCHAT_RATE_DB: {
        prepare: (sql) => ({
          bind: (...args) => ({
            first: async () => null,
            run: async () => {
              calls.push([sql, args]);
              return result;
            },
          }),
        }),
      },
    },
  };
}
test('public hero uses the bundled image before the first CMS save', async () => {
  const response = await onRequestGet(context());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).heroBackgroundImageUrl, '/images/careers-hero.webp');
});
test('hero settings writes require admin auth and reject executable/traversal URLs', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json([]);
    for (const url of [
      'javascript:alert(1)',
      '//evil.example/hero.webp',
      'https://markchat.co.ke/media/../hero.webp',
    ]) {
      const ctx = context('PUT', { heroBackgroundImageUrl: url, heroBackgroundAlt: 'Office' });
      assert.equal((await onRequestPut(ctx)).status, 400);
      assert.equal(ctx.calls.length, 0);
    }
    const ctx = context('PUT', {
      heroBackgroundImageUrl: '/images/careers-hero.webp',
      heroBackgroundAlt: 'Office',
    });
    globalThis.fetch = async () => Response.json({ error: 'Denied' }, { status: 403 });
    assert.equal((await onRequestPut(ctx)).status, 403);
    assert.equal(ctx.calls.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
test('hero only acknowledges a confirmed D1 write and preserves mobile focal settings', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json([]);
    const settings = {
      heroBackgroundImageUrl: '/images/careers-hero.webp',
      heroBackgroundAlt: 'Office',
      heroFocalX: 64,
      heroMobileFocalX: 70,
    };
    const failed = context('PUT', settings, { success: true, meta: { changes: 0 } });
    assert.equal((await onRequestPut(failed)).status, 503);
    const saved = context('PUT', settings);
    const response = await onRequestPut(saved);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).heroMobileFocalX, 70);
    assert.equal(saved.calls.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});
