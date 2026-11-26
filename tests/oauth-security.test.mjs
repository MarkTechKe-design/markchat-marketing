import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const callback = fs.readFileSync('src/pages/auth/callback.astro', 'utf8');
const google = fs.readFileSync('src/components/forms/SocialAuthButtons.astro', 'utf8');
const login = fs.readFileSync('src/components/forms/LoginForm.astro', 'utf8');

test('Google button contains four-color offline icon and accessible label', () => {
  for (const color of ['#4285F4', '#34A853', '#FBBC05', '#EA4335']) {
    assert.ok(google.includes(color));
  }
  assert.match(google, /viewBox="0 0 24 24"/);
  assert.match(google, /Continue with Google/);
  assert.doesNotMatch(google, /simple-icons:google/);
});

test('OAuth callback accepts only browser-bound one-use server ticket exchange', () => {
  assert.match(callback, /\/api\/v1\/auth\/google\/exchange/);
  assert.match(callback, /credentials: 'include'/);
  assert.match(callback, /window\.history\.replaceState/);
  assert.match(callback, /hadFragment/);
  assert.doesNotMatch(callback, /params\.get\('token'\)/);
  assert.doesNotMatch(callback, /params\.get\('ssoUrl'\)/);
});

test('Password login refuses arbitrary SSO redirects', () => {
  assert.match(login, /https:\/\/app\.markchat\.co\.ke/);
  assert.match(login, /candidate\.pathname\.startsWith\('\/app\/'\)/);
  assert.doesNotMatch(login, /const destination = payload\.ssoUrl \|\| targetRedirect/);
});
