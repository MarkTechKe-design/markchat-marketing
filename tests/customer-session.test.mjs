import test from 'node:test';
import assert from 'node:assert/strict';
import {
  customerDestination,
  persistCustomerSession,
  readCustomerSession,
  safeLocalRedirect,
  safeSsoRedirect,
} from '../src/lib/customer-session.ts';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test('a verified customer session is available in both browser stores', () => {
  const stores = { local: memoryStorage(), session: memoryStorage() };
  persistCustomerSession('signed.control-plane.session', stores);
  assert.equal(stores.local.getItem('markchat_cp_token'), 'signed.control-plane.session');
  assert.equal(stores.session.getItem('markchat_cp_token'), 'signed.control-plane.session');
  assert.equal(readCustomerSession(stores), 'signed.control-plane.session');
});

test('session storage remains usable when persistent browser storage is blocked', () => {
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
    removeItem() {
      throw new Error('blocked');
    },
  };
  const session = memoryStorage();
  persistCustomerSession('signed.customer.session', { local: blocked, session });
  assert.equal(readCustomerSession({ local: blocked, session }), 'signed.customer.session');
  const local = memoryStorage();
  persistCustomerSession('signed.customer.session', { local, session: blocked });
  assert.equal(readCustomerSession({ local, session: blocked }), 'signed.customer.session');
});

test('invalid sessions cannot overwrite an existing customer token', () => {
  const stores = { local: memoryStorage(), session: memoryStorage() };
  persistCustomerSession('existing.customer.session', stores);
  for (const value of [undefined, null, '', '  ', {}, true]) {
    assert.throws(() => persistCustomerSession(value, stores), /session/i);
  }
  assert.equal(readCustomerSession(stores), 'existing.customer.session');
});

test('the current tab session takes precedence over older persistent credentials', () => {
  const stores = { local: memoryStorage(), session: memoryStorage() };
  stores.local.setItem('markchat_cp_token', 'old.session.token');
  stores.session.setItem('markchat_cp_token', 'current.session.token');
  assert.equal(readCustomerSession(stores), 'current.session.token');
});

test('SSO accepts the production Core origin and app paths', () => {
  const url = 'https://app.markchat.co.ke/app/login?sso_auth_token=abc&email=a%40example.com';
  assert.equal(safeSsoRedirect(url, 'https://markchat.co.ke'), url);
});

test('loopback Core SSO is limited to actual local development pages', () => {
  for (const url of [
    'http://localhost:3000/app/accounts/12/dashboard',
    'http://127.0.0.1:3000/app/login?token=abc',
  ]) {
    assert.equal(safeSsoRedirect(url, 'http://localhost:4321'), url);
    assert.equal(safeSsoRedirect(url, 'http://127.0.0.1:4322'), url);
    assert.equal(safeSsoRedirect(url, 'http://[::1]:4321'), url);
    for (const origin of [
      'https://markchat.co.ke',
      'https://staging.markchat.co.ke',
      'http://localhost.attacker.example',
      'https://127.0.0.1.attacker.example',
      '',
    ]) {
      assert.equal(safeSsoRedirect(url, origin), null, origin);
      assert.equal(
        customerDestination(url, '/billing?plan=growth', origin),
        '/billing?plan=growth'
      );
    }
  }
});

test('SSO rejects malicious origins, credentials and paths before browser normalization', () => {
  for (const url of [
    'https://attacker.example/app/login',
    'https://app.markchat.co.ke.attacker.example/app/login',
    'https://app.markchat.co.ke@attacker.example/app/login',
    'https://user:password@app.markchat.co.ke/app/login',
    'https://app.markchat.co.ke/admin',
    'https://app.markchat.co.ke/app/../admin',
    'https://app.markchat.co.ke/elsewhere/../app/login',
    'https://app.markchat.co.ke/app/./login',
    'https://app.markchat.co.ke/app/%2e%2e/admin',
    'https://app.markchat.co.ke/app/%252e%252e/admin',
    'https://app.markchat.co.ke/app/%2flogin',
    'https://app.markchat.co.ke/app/%255clogin',
    'https://app.markchat.co.ke/app/\\../admin',
    'https://app.markchat.co.ke/app//login',
    'https://app.markchat.co.ke/app/login#token=secret',
    'https://app.markchat.co.ke/app/log\nin',
    '//app.markchat.co.ke/app/login',
    'javascript:alert(1)',
  ]) {
    assert.equal(safeSsoRedirect(url), null, url);
  }
});

test('local redirect preserves billing intent and rejects escaped external paths', () => {
  assert.equal(
    safeLocalRedirect('/billing?plan=scale&interval=monthly'),
    '/billing?plan=scale&interval=monthly'
  );
  for (const value of [
    '//evil.example',
    '/\\evil.example',
    '/%252fevil.example',
    '/%2fevil.example',
    '/billing#token=secret',
    '/app/../admin',
    '/%2e%2e/admin',
    '/\u007fevil',
    'https://evil.example',
    '/billing?redirect=https://evil.example',
  ])
    assert.equal(safeLocalRedirect(value), '/billing', value);
});

test('absent or unsafe SSO falls back to the validated billing destination', () => {
  assert.equal(customerDestination(undefined), '/billing');
  assert.equal(customerDestination('https://evil.example/app/login'), '/billing');
  assert.equal(
    customerDestination(null, '/billing?plan=starter&interval=monthly'),
    '/billing?plan=starter&interval=monthly'
  );
  assert.equal(
    customerDestination('https://app.markchat.co.ke/app/login?token=abc', '/billing'),
    'https://app.markchat.co.ke/app/login?token=abc'
  );
});
