import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const layout = fs.readFileSync('src/layouts/DashboardLayout.astro', 'utf8');
const api = fs.readFileSync('src/lib/cms-api.ts', 'utf8');
const attributes = fs.readFileSync('.gitattributes', 'utf8');

test('CMS dashboard supports direct and mounted navigation without weakening authentication', () => {
  assert.match(layout, /cmsMounted\s*=\s*path\.startsWith\('\/_cms\/dashboard'/);
  assert.match(layout, /cmsPath\s*=\s*cmsMounted\s*\?\s*path\.slice\(prefix\.length\)/);
  assert.match(layout, /element\.setAttribute\(attribute, '\/_cms' \+ value\)/);
  assert.match(layout, /window\.location\.href\s*=\s*prefix \+ '\/dashboard\/login\?redirect='/);
  assert.match(layout, /sessionStorage\.getItem\('markchat_admin_token'\)/);
});

test('CMS API retains Bearer authorization with same-origin /_cms base when mounted', () => {
  assert.match(api, /window\.location\.pathname\.startsWith\('\/_cms\/dashboard'/);
  assert.match(api, /\? '\/_cms'/);
  assert.match(api, /Authorization:\s*`Bearer \$\{getAdminToken\(\)\}`/);
  assert.match(api, /PUBLIC_BRIDGE_API_URL/);
});

test('LF checkout rules cover JavaScript, Astro, JSON, SQL and shell scripts', () => {
  for (const ext of ['sh', 'js', 'mjs', 'ts', 'astro', 'json', 'sql']) {
    assert.ok(attributes.includes(`*.${ext} text eol=lf`));
  }
});

test('CMS login uses a verified session token and allows only local dashboard redirects', () => {
  const login = fs.readFileSync('src/pages/dashboard/login.astro', 'utf8');
  assert.match(login, /const cmsApiBase = mounted \? '\/_cms' : bridgeApiUrl/);
  assert.match(login, /const token = data\.token/);
  assert.match(login, /typeof token !== 'string'/);
  assert.match(login, /requested\.startsWith\('\/\/'\)/);
  assert.match(login, /window\.location\.assign\(destination\)/);
  assert.ok(!login.includes('data.token || entered'));
});
