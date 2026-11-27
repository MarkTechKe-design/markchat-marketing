import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHeroMedia, sanitizeHeroMediaUrl } from '../src/lib/hero-media.ts';

test('Careers has a bundled hero and bounded desktop/mobile focal points', () => {
  const media = normalizeHeroMedia('careers', null);
  assert.equal(media.heroBackgroundImageUrl, '/images/careers-hero.webp');
  assert.equal(media.heroMediaMode, 'hybrid');
  assert.ok(media.heroBackgroundAlt.length > 15);
  const edited = normalizeHeroMedia('careers', {
    heroFocalX: 73,
    heroFocalY: 46,
    heroMobileFocalX: 64,
    heroMobileFocalY: 40,
  });
  assert.equal(edited.heroFocalX, 73);
  assert.equal(edited.heroMobileFocalX, 64);
  const invalid = normalizeHeroMedia('careers', {
    heroFocalX: -1,
    heroFocalY: '50%; color:red',
    heroMobileFocalX: 101,
  });
  for (const key of ['heroFocalX', 'heroFocalY', 'heroMobileFocalX', 'heroMobileFocalY']) {
    assert.equal(typeof invalid[key], 'number');
    assert.ok(invalid[key] >= 0 && invalid[key] <= 100);
  }
});

test('hero URLs reject encoded and HTTPS traversal before URL normalization', () => {
  for (const url of [
    '/images/../careers.webp',
    '/images/%2e%2e/careers.webp',
    '/images/%252e%252e/careers.webp',
    'https://markchat.co.ke/media/../photo.webp',
    'https://markchat.co.ke/media/%2e%2e/photo.webp',
    'https://markchat.co.ke/media/%252e%252e/photo.webp',
    '//markchat.co.ke/images/photo.webp',
    'javascript:alert(1)',
    'data:image/png;base64,eA==',
    'https://cdn.example.com.evil.test/photo.webp',
    'https://cdn.example.com:8443/photo.webp',
  ])
    assert.equal(sanitizeHeroMediaUrl(url, 'https://cdn.example.com'), '', url);
  assert.equal(sanitizeHeroMediaUrl('/images/careers-hero.webp'), '/images/careers-hero.webp');
  assert.equal(
    sanitizeHeroMediaUrl('https://cdn.example.com/photo.webp', 'https://cdn.example.com'),
    'https://cdn.example.com/photo.webp'
  );
});
