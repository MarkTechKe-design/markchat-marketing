import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (file) => readFileSync(file, 'utf8');

test('MarkChat header stays sticky, centered, elevated after scroll, and menus are viewport aware', () => {
  const header = read('src/components/layout/Header.astro');
  const marketing = read('src/layouts/MarketingLayout.astro');
  assert.match(header, /sticky top-3 sm:top-4 z-50/);
  assert.match(header, /data-scrolled="false"/);
  assert.match(header, /window\.scrollY > 16/);
  assert.match(header, /positionPanel/);
  assert.match(header, /mobileMenuPanel\.style\.maxHeight/);
  for (const name of ['product', 'solutions', 'resources']) {
    assert.match(header, new RegExp('data-menu="' + name + '"'));
  }
  assert.match(marketing, /overflow-x-clip/);
});

test('Marketing primary action tokens match brand blue in both themes and remain accessible', () => {
  const classes = read('src/lib/cta-classes.ts');
  for (const value of [
    'bg-[#2563EB]',
    'hover:bg-[#1D4ED8]',
    'active:bg-[#1E40AF]',
    'dark:bg-[#3B82F6]',
    'dark:hover:bg-[#2563EB]',
    'focus-visible:ring-2',
    'motion-reduce:transform-none',
  ]) {
    assert.ok(classes.includes(value), 'Missing CTA rule: ' + value);
  }
  for (const path of [
    'src/components/layout/Header.astro',
    'src/components/design-system/MCButton.astro',
    'src/components/sections/marketing/CTA.astro',
    'src/components/sections/pricing/PricingTable.astro',
    'src/components/forms/ContactForm.astro',
    'src/components/forms/DemoRequestForm.astro',
    'src/components/forms/LoginForm.astro',
    'src/components/forms/RegisterForm.astro',
    'src/components/forms/ForgotPasswordForm.astro',
    'src/components/forms/ResetPasswordForm.astro',
    'src/pages/billing.astro',
    'src/pages/features.astro',
    'src/pages/integrations.astro',
    'src/pages/markcopilot.astro',
  ]) {
    assert.match(read(path), /primaryCtaClasses/, path);
  }
});

test('All four named motion primitives are safe for reduced motion and accessible rendering', () => {
  for (const name of [
    'FloatingTelemetryCard',
    'SlidingChannelRail',
    'SlidingIntegrationRail',
    'KineticWorkflowCard',
  ]) {
    const file = 'src/components/motion/' + name + '.astro';
    assert.ok(existsSync(file), file);
    const source = read(file);
    assert.match(source, /prefers-reduced-motion: reduce/, file);
    assert.doesNotMatch(source, /blur-3xl|radial-gradient|bg-gradient-to-/, file);
  }
  assert.match(read('src/components/motion/SlidingChannelRail.astro'), /aria-hidden="true"/);
  assert.match(read('src/components/motion/SlidingIntegrationRail.astro'), /aria-hidden="true"/);
  assert.match(read('src/layouts/BaseLayout.astro'), /IntersectionObserver/);
});

test('Motion primitives render into production pages without claiming live payment status', async () => {
  const routes = [
    ['/', /data-mc-channel-rail/],
    ['/', /data-mc-integration-rail/],
    ['/', /data-mc-floating-card/],
    ['/integrations/', /data-mc-integration-rail/],
    ['/features/', /data-mc-kinetic-card/],
    ['/solutions/', /data-mc-kinetic-card/],
    ['/markcopilot/', /data-mc-floating-card/],
  ];
  for (const [route, pattern] of routes) {
    const response = await fetch('http://localhost:4321' + route, {
      signal: AbortSignal.timeout(6000),
    });
    assert.equal(response.status, 200, route);
    assert.match(await response.text(), pattern, route);
  }
  const homepage = await (await fetch('http://localhost:4321/')).text();
  assert.doesNotMatch(homepage, /live payment received|verified real transaction/i);
});
