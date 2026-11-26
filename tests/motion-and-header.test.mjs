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

test('Brand-colored marquee icon tiles preserve distinct light/dark palettes and original motion contracts', () => {
  const specs = [
    {
      file: 'src/components/motion/SlidingChannelRail.astro',
      variable: 'channel',
      animation: 'animation: mc-marquee-left 43s linear infinite;',
      brands: [
        ['WhatsApp Cloud API', 'bg-[#25D366]/12', 'dark:text-[#4ADE80]'],
        ['Instagram DM', 'bg-[#E1306C]/12', 'dark:text-[#F472B6]'],
        ['Facebook Messenger', 'bg-[#0084FF]/12', 'dark:text-[#38BDF8]'],
        ['TikTok Business Messaging', 'bg-[#0F172A]/8', 'dark:bg-[#25F4EE]/15'],
        ['Telegram', 'bg-[#26A5E4]/12', 'dark:text-[#38BDF8]'],
        ['Website Live Chat', 'bg-[#2563EB]/12', 'dark:text-[#60A5FA]'],
        ['Email Inbox', 'bg-[#6366F1]/12', 'dark:text-[#A5B4FC]'],
      ],
    },
    {
      file: 'src/components/motion/SlidingIntegrationRail.astro',
      variable: 'integration',
      animation: 'animation: mc-marquee-right 48s linear infinite;',
      brands: [
        ['Safaricom M-Pesa Daraja', 'bg-[#43B02A]/12', 'dark:text-[#4ADE80]'],
        ['Pochi la Biashara Sync', 'bg-[#0D9488]/12', 'dark:text-[#2DD4BF]'],
        ['Shared Bank Paybill', 'bg-[#1D4ED8]/12', 'dark:text-[#93C5FD]'],
        ["Africa's Talking SMS", 'bg-[#F59E0B]/14', 'dark:text-[#FBBF24]'],
        ['Shopify', 'bg-[#95BF47]/15', 'dark:text-[#A3E635]'],
        ['REST APIs & Webhooks', 'bg-[#7C3AED]/12', 'dark:text-[#C4B5FD]'],
        ['Google SSO', 'bg-[#EA4335]/12', 'dark:text-[#FCA5A5]'],
      ],
    },
  ];

  for (const { file, variable, animation, brands } of specs) {
    const source = read(file);
    const mappings = [];
    for (const [title, lightColor, darkColor] of brands) {
      const quotedTitle = title.includes("'") ? `"${title}"` : `'${title}'`;
      const start = source.indexOf(`title: ${quotedTitle},`);
      assert.notEqual(start, -1, `${file}: missing ${title}`);
      const end = source.indexOf('  },', start);
      assert.notEqual(end, -1, `${file}: incomplete mapping for ${title}`);
      const definition = source.slice(start, end);
      assert.match(definition, /iconClasses:/, `${title}: missing icon colors`);
      assert.ok(definition.includes(lightColor), `${title}: missing light brand color`);
      assert.ok(definition.includes(darkColor), `${title}: missing dark brand color`);
      assert.match(definition, /border-\[#/);
      assert.match(definition, /dark:border-\[#/);
      mappings.push(definition.match(/bg-\[#[0-9A-F]+\]\/\d+/)?.[0]);
    }
    assert.equal(new Set(mappings).size, brands.length, `${file}: colors must be distinct`);
    assert.equal(source.split(`data-mc-brand-icon={${variable}.title}`).length - 1, 2);
    assert.equal(source.split(`${variable}.iconClasses`).length - 1, 2);
    assert.match(source, /aria-hidden="true"/);
    assert.match(source, /prefers-reduced-motion: reduce/);
    assert.ok(source.includes(animation), `${file}: marquee speed changed`);
    assert.match(source, /animation-play-state: paused/);
    assert.match(source, /mask-image: linear-gradient\(to right, transparent/);
    assert.doesNotMatch(source, /bg-gradient|radial-gradient|blur-3xl/);
  }
});

test('Brand-colored marquee icon tiles appear in production HTML on both rails', async () => {
  const response = await fetch('http://localhost:4321/', {
    signal: AbortSignal.timeout(6000),
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  // Astro may serialize '&' as a named or numeric HTML entity. Compare decoded
  // attribute values rather than coupling this test to its escaping strategy.
  const brandIconTitles = Array.from(
    html.matchAll(/data-mc-brand-icon="([^"]*)"/g),
    ([, value]) => {
      let decoded = value;
      for (let pass = 0; pass < 2; pass++) {
        decoded = decoded.replace(/&(?:amp|#0*38|#x0*26);/gi, '&');
      }
      return decoded;
    }
  );
  for (const title of [
    'WhatsApp Cloud API',
    'Instagram DM',
    'TikTok Business Messaging',
    'Safaricom M-Pesa Daraja',
    'Shopify',
    'REST APIs & Webhooks',
  ]) {
    assert.ok(
      brandIconTitles.includes(title),
      `Missing brand icon for ${title}. Rendered labels: ${brandIconTitles.join(', ')}`
    );
  }
  assert.ok(html.includes('bg-[#25D366]/12'), 'Missing WhatsApp icon color in HTML');
  assert.ok(html.includes('dark:text-[#A3E635]'), 'Missing Shopify dark-mode icon color in HTML');
});
