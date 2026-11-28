import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/careers-availability.ts';

const request = new Request('https://markchat.co.ke/api/careers/availability');

test('careers availability fails closed when Control Plane is not configured', async () => {
  const result = await onRequestGet({ request, env: {} });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store, max-age=0');
  assert.deepEqual(await result.json(), {
    recruitmentOpen: false,
    talentPoolOpen: false,
    acceptingApplications: false,
    acceptingTalentPool: false,
    portalReady: false,
  });
});

test('careers availability never trusts an unverified open flag', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({
      recruitmentOpen: true,
      talentPoolOpen: true,
      acceptingApplications: true,
      acceptingTalentPool: true,
      portalReady: false,
    });
    const response = await onRequestGet({ request, env: { CONTROL_PLANE_API_URL: 'https://api.example.co.ke' } });
    assert.equal((await response.json()).acceptingApplications, false);
    assert.equal(response.headers.get('Cache-Control'), 'no-store, max-age=0');
  } finally {
    globalThis.fetch = previous;
  }
});

test('careers availability handles unreachable, malformed and non-2xx upstream safely', async () => {
  const previous = globalThis.fetch;
  const env = { CONTROL_PLANE_API_URL: 'https://api.example.co.ke' };
  try {
    for (const implementation of [
      async () => { throw new Error('outage'); },
      async () => Response.json({ error: 'unavailable' }, { status: 503 }),
      async () => Response.json({ recruitmentOpen: true }, { status: 200 }),
    ]) {
      globalThis.fetch = implementation;
      const response = await onRequestGet({ request, env });
      assert.equal((await response.json()).acceptingApplications, false);
    }
  } finally {
    globalThis.fetch = previous;
  }
});
