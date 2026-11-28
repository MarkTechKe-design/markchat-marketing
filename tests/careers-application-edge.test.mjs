import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listPublicRoles,
  getPublicRole,
  submitApplication,
} from '../functions/api/careers.ts';

const env = { CONTROL_PLANE_API_URL: 'https://api.example.co.ke' };
const get = () => new Request('https://markchat.co.ke/api/careers/roles');

test('public vacancies fail closed when the backend is unconfigured', async () => {
  const response = await listPublicRoles({ request: get(), env: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, roles: [] });
  assert.match(response.headers.get('cache-control'), /no-store/);
});

test('job slug validation rejects path traversal and unavailable roles', async () => {
  const invalid = await getPublicRole({ request: get(), env }, '../admin');
  assert.equal(invalid.status, 404);
  const unavailable = await getPublicRole({ request: get(), env: {} }, 'senior-engineer');
  assert.equal(unavailable.status, 404);
});

test('public CV intake requires same-origin consent and a configured backend', async () => {
  const crossOrigin = new Request('https://markchat.co.ke/api/careers/apply', {
    method: 'POST',
    headers: {
      Origin: 'https://malicious.example',
      'Content-Type': 'application/json',
      'Sec-Fetch-Site': 'cross-site',
    },
    body: '{}',
  });
  const denied = await submitApplication({ request: crossOrigin, env });
  assert.equal(denied.status, 403);
  const local = new Request('https://markchat.co.ke/api/careers/apply', {
    method: 'POST',
    headers: { Origin: 'https://markchat.co.ke', 'Content-Type': 'application/json' },
    body: '{}',
  });
  const closed = await submitApplication({ request: local, env: {} });
  assert.equal(closed.status, 503);
});

test('unconfirmed backend response never yields a candidate receipt', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ success: false }, { status: 201 });
    const request = new Request('https://markchat.co.ke/api/careers/apply', {
      method: 'POST',
      headers: { Origin: 'https://markchat.co.ke', 'Content-Type': 'application/json' },
      body: JSON.stringify({ placeholder: true }),
    });
    const response = await submitApplication({ request, env });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).success, false);
  } finally {
    globalThis.fetch = previous;
  }
});
