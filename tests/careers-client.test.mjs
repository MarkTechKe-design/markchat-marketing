import test from 'node:test';
import assert from 'node:assert/strict';
import {
  submitCareerApplication,
  fetchCareerApplications,
  updateCareerApplicationStatus,
  upsertCareer,
  updateItemStatus,
  deleteCmsItem,
  fetchCareers,
} from '../src/lib/cms-api.ts';

const id = '53b3f8ad-fd1c-467f-8be6-dff9029f2a28';
function form() {
  const body = new FormData();
  body.set('fullName', 'Test Applicant');
  body.set('email', 'candidate@example.test');
  body.set('consent', 'true');
  body.set('cv', new File(['%PDF-1.7\n%%EOF'], 'resume.pdf', { type: 'application/pdf' }));
  return body;
}

test('Careers client requires a confirmed 201 from the multipart edge API', async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, payload] of [
      [200, { success: true, id }],
      [201, { success: false, id }],
      [503, { error: 'Unavailable' }],
    ]) {
      globalThis.fetch = async () => Response.json(payload, { status });
      await assert.rejects(submitCareerApplication('general', form()));
    }
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/careers/apply');
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get('careerId'), 'general');
      assert.ok(options.body.get('cv') instanceof File);
      assert.equal(options.headers?.['Content-Type'], undefined);
      return Response.json({ success: true, id, message: 'Saved' }, { status: 201 });
    };
    assert.equal((await submitCareerApplication('general', form())).id, id);
    globalThis.fetch = async () => {
      throw new Error('Network offline');
    };
    await assert.rejects(submitCareerApplication('general', form()));
  } finally {
    globalThis.fetch = original;
  }
});

test('Candidate details are not fetched or synthesized during static generation', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error('Must not fetch candidate PII at build time');
    };
    assert.deepEqual(await fetchCareerApplications(), []);
  } finally {
    globalThis.fetch = original;
  }
});

test('Admin status changes use the existing session token and do not pretend failed saves succeeded', async () => {
  const original = globalThis.fetch;
  const originalWindow = globalThis.window;
  try {
    globalThis.window = { sessionStorage: { getItem: () => 'test-admin-session' } };
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/careers/applications/' + id);
      assert.equal(options.headers.Authorization, 'Bearer test-admin-session');
      assert.deepEqual(JSON.parse(options.body), { status: 'shortlisted' });
      return Response.json({ success: true });
    };
    assert.equal(await updateCareerApplicationStatus(id, 'reviewed'), true);
    globalThis.fetch = async () => Response.json({ success: false }, { status: 403 });
    await assert.rejects(updateCareerApplicationStatus(id, 'hired'));
  } finally {
    globalThis.fetch = original;
    globalThis.window = originalWindow;
  }
});

test('Careers role editor requires a positive CMS acknowledgement before changing the fallback catalog', async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, payload] of [
      [503, { error: 'Rejected' }],
      [401, { error: 'Unauthorized' }],
      [200, {}],
      [200, { error: 'Session expired' }],
      [200, { success: false }],
      [200, { success: 'true' }],
    ]) {
      globalThis.fetch = async () => Response.json(payload, { status });
      const before = await fetchCareers();
      await assert.rejects(
        upsertCareer({
          id: 'job-1',
          title: 'Rejected change',
          department: 'Engineering',
          location: 'Nairobi',
        }),
        undefined,
        JSON.stringify({ status, payload })
      );
      await assert.rejects(updateItemStatus('careers', 'job-1', 'archived'));
      await assert.rejects(deleteCmsItem('careers', 'job-1'));
      assert.deepEqual(await fetchCareers(), before);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('Careers role editor accepts explicit acknowledgements and matching saved resources', async () => {
  const original = globalThis.fetch;
  const career = {
    id: 'job-1',
    title: 'Confirmed role',
    department: 'Engineering',
    location: 'Nairobi',
    status: 'paused',
  };
  try {
    for (const payload of [{ success: true }, career, { data: career }, { career }]) {
      globalThis.fetch = async () => Response.json(payload);
      assert.equal((await upsertCareer(career)).title, career.title);
    }
    globalThis.fetch = async () => Response.json({ ...career, id: 'unrelated' });
    await assert.rejects(upsertCareer(career));
    globalThis.fetch = async () => new Response(null, { status: 204 });
    assert.equal(await updateItemStatus('careers', 'job-1', 'paused'), true);
    assert.equal(await deleteCmsItem('careers', 'job-1'), true);
  } finally {
    globalThis.fetch = original;
  }
});
