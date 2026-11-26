import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=(path)=>fs.readFileSync(path,'utf8');
const base=read('src/layouts/BaseLayout.astro');
const auth=read('src/layouts/AuthLayout.astro');
const dashboard=read('src/components/dashboard/Sidebar.astro');
const header=read('src/components/layout/Header.astro');
const footer=read('src/components/layout/Footer.astro');
const config=read('src/config/site.ts');

test('Official MarkChat icon manifest and fallback PNG/ICO are connected to all BaseLayout pages',()=>{
 for(const asset of ['/favicon.ico','/favicon-32x32.png','/apple-touch-icon.png','/site.webmanifest'])
   assert.ok(base.includes(asset),asset);
 assert.doesNotMatch(base,/href="\/favicon.svg"/);
});
test('Public header, footer and authentication layout use supplied light/dark PNG artwork',()=>{
 for(const content of [auth,header,footer]) {
   assert.ok(content.includes('/brand/markchat-logo.png'));
   assert.ok(content.includes('/brand/markchat-logo-dark.png'));
   assert.ok(content.includes('object-contain'));
   assert.ok(content.includes('dark:hidden'));
   assert.ok(content.includes('dark:block'));
 }
 assert.ok(config.includes("'/brand/markchat-logo.png'"));
 assert.doesNotMatch(header,/src="\/logo.svg"/);
});
test('CMS collapsed navigation uses official favicon, never a Lucide placeholder brand',()=>{
 assert.ok(dashboard.includes('/apple-touch-icon.png'));
 assert.ok(dashboard.includes('sidebar-collapsed'));
 assert.doesNotMatch(dashboard,/lucide:layout-dashboard/);
});
