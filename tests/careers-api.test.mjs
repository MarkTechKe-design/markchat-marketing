import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { onRequestPost } from '../functions/api/careers/apply.ts';
import { onRequestGet as list } from '../functions/api/careers/applications.ts';
import { onRequestPatch } from '../functions/api/careers/application.ts';
import { onRequestGet as download } from '../functions/api/careers/cv.ts';

const origin = 'https://markchat.co.ke';
const pdf = readFileSync(new URL('./fixtures/careers/sample-cv.pdf', import.meta.url));

test('production and preview observability redact candidate search query strings', () => {
  const config = JSON.parse(
    readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(
      /,\s*([}\]])/g,
      '$1'
    )
  );
  assert.equal(config.observability.redact_query_string, true);
  assert.equal(config.previews.observability.redact_query_string, true);
});

function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../sql/markchat-careers.sql', import.meta.url), 'utf8'));
  sql.exec(readFileSync(new URL('../sql/markchat-rate-limits.sql', import.meta.url), 'utf8'));
  const objects = new Map();
  const env = {
    MARKCHAT_RATE_DB: {
      prepare(query) {
        const stmt = sql.prepare(query);
        return {
          bind(...args) {
            return {
              async first() {
                return stmt.get(...args) || null;
              },
              async all() {
                return { success: true, results: stmt.all(...args) };
              },
              async run() {
                return { success: true, meta: stmt.run(...args) };
              },
            };
          },
        };
      },
    },
    MARKCHAT_CAREERS_BUCKET: {
      async put(key, data) {
        objects.set(key, data);
        return { key };
      },
      async get(key) {
        return objects.has(key) ? { body: objects.get(key) } : null;
      },
      async delete(key) {
        objects.delete(key);
      },
    },
    RATE_HASH_SECRET: 'x'.repeat(32),
    CMS_API_BASE_URL: 'https://cms.example/bridge',
    RESEND_API_KEY: 'secret',
    RESEND_FROM_EMAIL: 'careers@markchat.co.ke',
  };
  function request(overrides = {}, headers = {}) {
    const form = new FormData();
    const fields = {
      careerId: 'general',
      careerTitle: 'Forged',
      fullName: 'Test <Reader>',
      email: 'tester@example.com',
      phone: '+254712345678',
      specialization: 'Engineering',
      location: 'Nairobi',
      coverLetter: 'First line\nSecond line',
      consent: 'true',
      website: '',
      startedAt: String(Date.now() - 3000),
      cv: new File([pdf], 'candidate.pdf'),
      ...overrides,
    };
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return {
      env,
      request: new Request(origin + '/api/careers/apply', {
        method: 'POST',
        body: form,
        headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.1', ...headers },
      }),
    };
  }
  function admin(path, method = 'GET', body) {
    return {
      env,
      request: new Request(origin + path, {
        method,
        headers: {
          Origin: origin,
          Authorization: 'Bearer recruiter',
          'Content-Type': 'application/json',
        },
        body,
      }),
    };
  }
  return { env, objects, sql, request, admin };
}

test('durable apply, authenticated listing, status and attachment', async (t) => {
  const f = fixture();
  let sent;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).includes('resend.com')) {
      sent = JSON.parse(init.body);
      return Response.json({ id: 'message-id' });
    }
    assert.equal(String(url), 'https://cms.example/bridge/api/admin/cms/applications?limit=1');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer recruiter');
    return Response.json([]);
  });
  const response = await onRequestPost(f.request());
  assert.equal(response.status, 201);
  const { id } = await response.json();
  assert.ok(id);
  assert.equal(sent.reply_to, 'tester@example.com');
  assert.ok(sent.html.includes('&lt;Reader&gt;'));
  assert.ok(sent.text.includes('?application=' + id));
  const data = await (await list(f.admin('/api/careers/applications?search=tester'))).json();
  assert.equal(data.total, 1);
  assert.equal(data.applications[0].notificationSent, true);
  assert.equal(data.applications[0].hasCv, true);
  assert.ok(!Object.keys(data.applications[0]).some((k) => /key/i.test(k)));
  assert.notEqual(data.applications[0].careerTitle, 'Forged');
  assert.equal(
    (
      await onRequestPatch(
        f.admin(
          '/api/careers/applications/' + id,
          'PATCH',
          JSON.stringify({ status: 'interview' })
        ),
        id
      )
    ).status,
    200
  );
  const cv = await download(f.admin('/api/careers/cv/' + id), id);
  assert.match(cv.headers.get('Content-Disposition'), /^attachment/);
  assert.match(cv.headers.get('Content-Security-Policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await cv.arrayBuffer()), pdf);
});

test('invalid form, origin, throttling, rollback and auth failures', async (t) => {
  const f = fixture();
  t.mock.method(globalThis, 'fetch', async () => new Response('failure', { status: 502 }));
  assert.equal(
    (await onRequestPost(f.request({}, { Origin: 'https://wrong.example' }))).status,
    403
  );
  for (const bad of [
    { consent: 'on' },
    { website: 'trap' },
    { startedAt: String(Date.now()) },
    { linkedinUrl: 'javascript:foo' },
  ]) {
    assert.equal((await onRequestPost(f.request(bad))).status, 400);
  }
  const response = await onRequestPost(f.request());
  assert.equal(response.status, 201);
  assert.equal(f.objects.size, 1);
  f.sql.exec('DROP TABLE markchat_career_applications');
  assert.equal((await onRequestPost(f.request())).status, 503);
  assert.equal(f.objects.size, 2, 'retain the CV while the application table is unavailable');
  assert.equal((await onRequestPost(f.request())).status, 429);
  assert.equal((await list(f.admin('/api/careers/applications'))).status, 503);
});

test('bounded stream rejects a body without Content-Length', async () => {
  const { env } = fixture();
  const request = new Request(origin + '/api/careers/apply', {
    method: 'POST',
    duplex: 'half',
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(5242880 + 65537));
        c.close();
      },
    }),
    headers: {
      Origin: origin,
      'CF-Connecting-IP': '192.0.2.1',
      'Content-Type': 'multipart/form-data; boundary=test',
    },
  });
  assert.equal((await onRequestPost({ request, env })).status, 413);
});

test('auth requires exact CMS proof and rejects invalid cookie or service credentials', async (t) => {
  const { env, admin } = fixture();
  const context = admin('/api/careers/applications');
  context.request.headers.delete('Authorization');
  assert.equal((await list(context)).status, 401);
  context.request.headers.set('Cookie', 'markchat_admin_token=%');
  assert.equal((await list(context)).status, 401);
  context.request.headers.set('Cookie', 'markchat_admin_token=recruiter');
  env.CMS_SERVICE_TOKEN = 'recruiter';
  assert.equal((await list(context)).status, 401);
  delete env.CMS_SERVICE_TOKEN;
  let upstream;
  t.mock.method(globalThis, 'fetch', async () => upstream);
  for (const [response, code] of [
    [new Response('<html>'), 503],
    [Response.json({ success: true }), 503],
    [Response.json([{}]), 503],
    [Response.json('x'.repeat(129 * 1024)), 503],
    [new Response(null, { status: 403 }), 403],
    [new Response(null, { status: 401 }), 401],
    [Response.json([]), 200],
  ]) {
    upstream = response;
    assert.equal((await list(context)).status, code);
  }
  delete env.CMS_API_BASE_URL;
  assert.equal((await list(context)).status, 503);
});

test('failed object write, unconfirmed insert or missing bindings never acknowledges', async () => {
  for (const failure of ['bucket', 'emptyPut', 'throwPut', 'insert', 'noChanges', 'rate']) {
    const f = fixture();
    if (failure === 'bucket') delete f.env.MARKCHAT_CAREERS_BUCKET;
    if (failure === 'emptyPut') f.env.MARKCHAT_CAREERS_BUCKET.put = async () => null;
    if (failure === 'throwPut')
      f.env.MARKCHAT_CAREERS_BUCKET.put = async () => {
        throw Error();
      };
    if (failure === 'rate') delete f.env.RATE_HASH_SECRET;
    if (['insert', 'noChanges'].includes(failure)) {
      const prepare = f.env.MARKCHAT_RATE_DB.prepare;
      f.env.MARKCHAT_RATE_DB.prepare = (sql) =>
        sql.startsWith('INSERT INTO markchat_career_applications')
          ? {
              bind: () => ({
                run: async () => ({ success: failure === 'noChanges', meta: { changes: 0 } }),
              }),
            }
          : prepare(sql);
    }
    assert.equal((await onRequestPost(f.request())).status, 503, failure);
    assert.equal(f.objects.size, 0, failure);
  }
});

test('published roles are resolved by trusted source and unsent email stays pending', async (t) => {
  const f = fixture();
  let upstream = { id: 'job-1', status: 'draft', title: 'Draft role' };
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('resend.com')) return Response.json({});
    assert.equal(String(url), 'https://cms.example/bridge/api/public/careers/job-1');
    return Response.json(upstream);
  });
  const submit = () =>
    onRequestPost(f.request({ careerId: 'job-1', coverLetter: '', specialization: '' }));
  assert.equal((await submit()).status, 400);
  upstream = { ...upstream, status: 'published', title: 'Published role' };
  assert.equal((await submit()).status, 201);
  const row = f.sql
    .prepare('SELECT career_title, notification_sent FROM markchat_career_applications')
    .get();
  assert.equal(row.career_title, 'Published role');
  assert.equal(row.notification_sent, 0);
  delete f.env.CMS_API_BASE_URL;
  assert.equal((await submit()).status, 201);
  assert.equal((await onRequestPost(f.request({ careerId: 'constructor' }))).status, 400);
  assert.equal(
    (await onRequestPost(f.request({ githubUrl: 'https://example.com/a/%252e%252e/b' }))).status,
    400
  );
});

test('admin list filters, mutations and downloads enforce their boundaries', async (t) => {
  const f = fixture();
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  const id = crypto.randomUUID();
  for (const path of ['?limit=0', '?limit=101', '?offset=-1', '?id=a', '?status=bad']) {
    assert.equal((await list(f.admin('/api/careers/applications' + path))).status, 400);
  }
  const filter = await (
    await list(f.admin('/api/careers/applications?search=%25&status=interview&limit=10&offset=1'))
  ).json();
  assert.deepEqual(filter, { success: true, applications: [], total: 0, limit: 10, offset: 1 });
  const update = (payload) =>
    f.admin('/api/careers/applications/' + id, 'PATCH', JSON.stringify(payload));
  for (const body of [{ status: 'reviewed' }, { status: 'new', admin: true }, []]) {
    assert.equal((await onRequestPatch(update(body), id)).status, 400);
  }
  const wrongOrigin = update({ status: 'new' });
  wrongOrigin.request.headers.delete('Origin');
  assert.equal((await onRequestPatch(wrongOrigin, id)).status, 403);
  assert.equal((await onRequestPatch(update({ status: 'new' }), id)).status, 404);
  assert.equal((await download(f.admin('/api/careers/cv/' + id), id)).status, 404);
  const anonymous = f.admin('/api/careers/cv/' + id);
  anonymous.request.headers.delete('Authorization');
  assert.equal((await download(anonymous, id)).status, 401);
  assert.equal((await download(f.admin('/api/careers/cv/foo'), 'foo')).status, 400);
});

test('primary reconciliation preserves committed applications after acknowledgement loss', async (t) => {
  const transport = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ id: 'message' })
  );
  for (const mode of ['throw', 'unconfirmed']) {
    const f = fixture();
    const prepare = f.env.MARKCHAT_RATE_DB.prepare;
    f.env.MARKCHAT_RATE_DB.prepare = (sql) => {
      if (!sql.startsWith('INSERT INTO markchat_career_applications')) return prepare(sql);
      return {
        bind: (...args) => ({
          async run() {
            await prepare(sql)
              .bind(...args)
              .run();
            if (mode === 'throw') throw Error('lost acknowledgement');
            return { success: true, meta: {} };
          },
        }),
      };
    };
    assert.equal((await onRequestPost(f.request())).status, 503);
    const row = f.sql
      .prepare('SELECT cv_key, notification_sent FROM markchat_career_applications')
      .get();
    assert.equal(f.objects.has(row.cv_key), true);
    assert.equal(row.notification_sent, 0);
    assert.equal(transport.mock.callCount(), 0);
  }
});

test('unconfirmed notification flag emits a fixed operational code', async (t) => {
  const f = fixture();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'message-id' }));
  const warn = t.mock.method(console, 'warn', () => {});
  const prepare = f.env.MARKCHAT_RATE_DB.prepare;
  f.env.MARKCHAT_RATE_DB.prepare = (sql) =>
    sql.startsWith('UPDATE markchat_career_applications SET notification_sent')
      ? { bind: () => ({ run: async () => ({ success: true, meta: { changes: 0 } }) }) }
      : prepare(sql);
  assert.equal((await onRequestPost(f.request())).status, 201);
  assert.equal(
    f.sql.prepare('SELECT notification_sent FROM markchat_career_applications').get()
      .notification_sent,
    0
  );
  assert.deepEqual(
    warn.mock.calls.map((call) => call.arguments),
    [['CAREERS_NOTIFICATION_FLAG_UNCONFIRMED']]
  );
});
