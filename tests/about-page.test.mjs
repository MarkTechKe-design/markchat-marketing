import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('About page has a grounded Nairobi enterprise story', () => {
  const source = fs.readFileSync(path.resolve('src/pages/about.astro'), 'utf8');
  assert.match(source, /Nairobi roots/);
  assert.match(source, /Business conversations deserve enterprise-grade clarity/);
  assert.match(source, /Kenyan obligations/);
  assert.match(source, /ComplianceRail/);
  assert.match(source, /Explore Plans/);
  assert.match(source, /AboutOperationsVisual/);
  assert.match(source, /hasEditorialHero/);
  assert.match(source, /MCResponsiveHeroMedia/);
  assert.match(source, /Explore Careers/);
  assert.doesNotMatch(source, /Zero Payment Fraud|< 10s|100% uptime/);
  assert.doesNotMatch(source, /Kevin Otieno|Faith Mwangi|Brian Kiprop|Amina Hassan/);
});

test('Built about page contains mission and contact', () => {
  const output = path.resolve('dist/about/index.html');
  assert.ok(fs.existsSync(output), 'Run npm run build before testing');
  const html = fs.readFileSync(output, 'utf8');
  assert.match(html, /Business conversations deserve enterprise-grade clarity/);
  assert.match(html, /Contact MarkChat/);
  assert.match(html, /Data Protection Act, 2019/);
  assert.match(html, /data-about-operations-visual|data-mc-responsive-hero|data-mc-layered-hero/);
  assert.match(html, /Illustrative workflow only|Editorial illustration/);
  assert.match(html, /Explore Careers/);
  assert.doesNotMatch(html, /Kevin Otieno|Faith Mwangi|Brian Kiprop|Amina Hassan/);
});

test('About premium layout preserves truthful content and accessible section anchors', () => {
  const src = fs.readFileSync(path.resolve('src/pages/about.astro'), 'utf8');
  const visual = fs.readFileSync(
    path.resolve('src/components/about/AboutOperationsVisual.astro'),
    'utf8'
  );
  assert.match(src, /aria-labelledby="about-heading"/);
  assert.match(src, /aria-labelledby="mission-heading"/);
  assert.match(src, /aria-labelledby="approach-heading"/);
  assert.match(src, /dark:bg-background/);
  assert.match(src, /href="\/careers"/);
  assert.match(visual, /Illustrative workflow only/);
  assert.match(visual, /aria-label="Illustrative MarkChat team communication workflow"/);
  assert.doesNotMatch(visual, /<script|window\.|fetch\(|innerHTML/);
  assert.doesNotMatch(visual, /100%|guaranteed|real-time performance/i);
});
