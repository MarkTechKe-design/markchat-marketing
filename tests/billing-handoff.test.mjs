import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createBillingHandoff, safeCoreBillingOrigin } from '../src/lib/billing-handoff.ts';

const memory = () => {
  const entries = new Map();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
};
function fixture(options = {}) {
  const session = memory(),
    local = memory(),
    navigation = [],
    replaced = [];
  const context = {
    pageUrl: 'https://markchat.co.ke/billing?account_id=414&source=core',
    coreUrl: 'https://app.markchat.co.ke',
    storage: session,
    stores: { session, local },
    crypto: webcrypto,
    now: () => 1000000,
    navigate: (url) => navigation.push(url),
    replaceUrl: (url) => replaced.push(url),
    fetcher: async () => {
      throw new Error('Unexpected request');
    },
    ...options,
  };
  return { context, session, local, navigation, replaced, helper: createBillingHandoff(context) };
}

test('Core handoff origins reject arbitrary hosts, credentials and normalized traversal', () => {
  assert.equal(
    safeCoreBillingOrigin('https://app.markchat.co.ke', 'https://markchat.co.ke'),
    'https://app.markchat.co.ke'
  );
  assert.equal(
    safeCoreBillingOrigin('http://localhost:8088', 'http://localhost:4321'),
    'http://localhost:8088'
  );
  for (const target of [
    'https://app.markchat.co.ke.evil.test',
    'https://x@app.markchat.co.ke',
    'https://app.markchat.co.ke/../',
    'http://localhost:8088',
    '//app.markchat.co.ke',
    'https://app.markchat.co.ke?redirect=x',
  ]) {
    assert.equal(safeCoreBillingOrigin(target, 'https://markchat.co.ke'), null, target);
  }
});

test('new Core visits create a browser-bound challenge without placing verifier or JWT in URL', async () => {
  const run = fixture();
  const result = await run.helper.prepare('https://cp.markchat.co.ke');
  assert.equal(result.redirecting, true);
  assert.equal(run.navigation.length, 1);
  const next = new URL(run.navigation[0]);
  assert.equal(next.origin, 'https://app.markchat.co.ke');
  assert.equal(next.pathname, '/_cp/billing/start');
  assert.equal(next.searchParams.get('account_id'), '414');
  assert.match(next.searchParams.get('challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(next.searchParams.get('state'), /^[a-f0-9]{32}$/);
  const binding = JSON.parse(run.session.getItem('markchat_billing_handoff'));
  assert.equal(next.href.includes(binding.verifier), false);
  assert.equal(next.searchParams.has('token'), false);
});

test('successful proof exchange strips fragment first, checks account, and persists both stores', async () => {
  const run = fixture();
  await run.helper.begin('414');
  const binding = JSON.parse(run.session.getItem('markchat_billing_handoff'));
  let requested = 0;
  const context = {
    ...run.context,
    pageUrl: `${run.context.pageUrl}#core_handoff=${'x'.repeat(120)}&state=${binding.state}`,
    fetcher: async (url, init) => {
      requested++;
      assert.equal(run.replaced.length, 1);
      assert.equal(url, 'https://app.markchat.co.ke/_cp/billing/session');
      assert.equal(init.credentials, 'include');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(JSON.parse(init.body).verifier, binding.verifier);
      return new Response(
        JSON.stringify({ success: true, accountId: 414, token: 'signed.billing.session' })
      );
    },
  };
  const result = await createBillingHandoff(context).prepare('https://cp.markchat.co.ke');
  assert.equal(requested, 1);
  assert.equal(result.token, 'signed.billing.session');
  assert.equal(run.local.getItem('markchat_cp_token'), result.token);
  assert.equal(run.session.getItem('markchat_cp_token'), result.token);
  assert.equal(run.session.getItem('markchat_billing_handoff'), null);
  assert.equal(run.replaced.at(-1), '/billing?account_id=414');
  const reload = createBillingHandoff({
    ...run.context,
    pageUrl: 'https://markchat.co.ke' + run.replaced.at(-1),
  });
  assert.deepEqual(await reload.prepare('https://cp.markchat.co.ke'), {
    token: 'signed.billing.session',
    accountId: '414',
    redirecting: false,
  });
});

test('unsolicited or cross-tab proofs never send credentials to an exchange', async () => {
  const run = fixture({
    pageUrl: `https://markchat.co.ke/billing?account_id=414&source=core#core_handoff=${'x'.repeat(120)}&state=${'a'.repeat(32)}`,
  });
  await assert.rejects(run.helper.prepare('https://cp.markchat.co.ke'), /expired|verified|reopen/i);
  assert.equal(run.replaced.length, 1);
  assert.equal(run.local.getItem('markchat_cp_token'), null);
});

test('mismatched server account cannot retain a stale customer session', async () => {
  const run = fixture();
  await run.helper.begin('414');
  run.local.setItem('markchat_cp_token', 'old.customer.session');
  const binding = JSON.parse(run.session.getItem('markchat_billing_handoff'));
  const callback = createBillingHandoff({
    ...run.context,
    pageUrl: `${run.context.pageUrl}#core_handoff=${'x'.repeat(120)}&state=${binding.state}`,
    fetcher: async () =>
      new Response(
        JSON.stringify({ success: true, accountId: 415, token: 'wrong.tenant.session' })
      ),
  });
  await assert.rejects(callback.prepare('https://cp.markchat.co.ke'), /workspace|verified/i);
  assert.equal(run.local.getItem('markchat_cp_token'), null);
});

test('ordinary billing visits use the Item #1 session without a Core handshake', async () => {
  const run = fixture({ pageUrl: 'https://markchat.co.ke/billing?plan=scale' });
  run.local.setItem('markchat_cp_token', 'signed.customer.session');
  const result = await run.helper.prepare('https://cp.markchat.co.ke');
  assert.equal(result.token, 'signed.customer.session');
  assert.equal(result.accountId, null);
  assert.equal(result.redirecting, false);
  assert.equal(run.navigation.length, 0);
});

test('Core entry re-verifies the current user even when a cached admin session has the same account', async () => {
  let requests = 0;
  const run = fixture({
    fetcher: async (url, init) => {
      requests++;
      assert.equal(url, 'https://cp.markchat.co.ke/api/v1/billing/subscription?account_id=414');
      assert.equal(init.headers.Authorization, 'Bearer signed.customer.session');
      return new Response(JSON.stringify({ success: true, tenant: { chatwootAccountId: 414 } }));
    },
  });
  run.session.setItem('markchat_cp_token', 'signed.customer.session');
  assert.equal((await run.helper.prepare('https://cp.markchat.co.ke')).redirecting, true);
  assert.equal(requests, 0);
  assert.equal(run.navigation.length, 1);
});

test('malformed account selectors and denied handoffs stop without redirect loops', async () => {
  for (const query of [
    'account_id=0&source=core',
    'account_id=414&account_id=415&source=core',
    'source=core',
    'account_id=414&source=core&handoff_error=access_denied',
  ]) {
    const run = fixture({ pageUrl: `https://markchat.co.ke/billing?${query}` });
    await assert.rejects(run.helper.prepare('https://cp.markchat.co.ke'));
    assert.equal(run.navigation.length, 0);
  }
});

test('denied Core connections clear both cached identities and remove callback flags before login', async () => {
  const run = fixture({
    pageUrl:
      'https://markchat.co.ke/billing?account_id=414&source=core&handoff_error=sign_in_required',
  });
  run.session.setItem('markchat_cp_token', 'old.session.identity');
  run.local.setItem('markchat_cp_token', 'old.local.identity');
  await assert.rejects(run.helper.prepare('https://cp.markchat.co.ke'), /session expired/i);
  assert.equal(run.session.getItem('markchat_cp_token'), null);
  assert.equal(run.local.getItem('markchat_cp_token'), null);
  assert.equal(run.replaced.at(-1), '/billing?account_id=414');
  const reload = createBillingHandoff({
    ...run.context,
    pageUrl: 'https://markchat.co.ke' + run.replaced.at(-1),
  });
  assert.equal((await reload.prepare('https://cp.markchat.co.ke')).token, null);
});

test('a readable stale token that cannot be cleared stops Core handoff before navigation', async () => {
  const run = fixture();
  run.context.stores.local = {
    getItem: () => 'stale.identity',
    removeItem: () => {
      throw new Error('Storage locked');
    },
    setItem: () => {
      throw new Error('Storage locked');
    },
  };
  await assert.rejects(
    createBillingHandoff(run.context).prepare('https://cp.markchat.co.ke'),
    /could not be cleared/
  );
  assert.equal(run.navigation.length, 0);
});
