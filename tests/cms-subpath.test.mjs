import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const layout=fs.readFileSync('src/layouts/DashboardLayout.astro','utf8');
const api=fs.readFileSync('src/lib/cms-api.ts','utf8');
const nginxInstructions=fs.readFileSync('.gitattributes','utf8');
test('CMS dashboard supports both direct and /_cms mounted navigation without weakening its auth guard',()=>{
  assert.match(layout,/cmsMounted\s*=\s*path\.startsWith\('\/_cms\/dashboard'/);
  assert.match(layout,/cmsPath\s*=\s*cmsMounted\s*\?\s*path\.slice\(prefix\.length\)/);
  assert.match(layout,/element\.setAttribute\(attribute, '\/_cms' \+ value\)/);
  assert.match(layout,/window\.location\.href = prefix \+ '\/dashboard\/login\?redirect='/);
  assert.match(layout,/sessionStorage\.getItem\('markchat_admin_token'\)/);
});
test('CMS API uses existing Bearer token, with same-origin /_cms API only on the mounted hostname',()=>{
  assert.match(api,/window\.location\.pathname\.startsWith\('\/_cms\/dashboard'/);
  assert.match(api,/\? '\/_cms'/);
  assert.match(api,/Authorization:\s*`Bearer \$\{getAdminToken\(\)\}`/);
  assert.match(api,/PUBLIC_BRIDGE_API_URL/);
});
test('LF checkout rules are explicit for JavaScript Astro and shell files',()=>{
  for(const ext of ['sh','js','mjs','ts','astro','json','sql'])
    assert.ok(nginxInstructions.includes(`*.${ext} text eol=lf`));
});
