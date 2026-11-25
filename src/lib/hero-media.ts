/**
 * Safe, framework-independent public hero-media contract.
 * Preserve source visual attribution: editorial assets are not MarkChat screenshots.
 */
import type { HeroMediaPage, HeroMediaSettings, HeroMediaMode, HeroScrimStrength } from './types';

export const HERO_MEDIA_PAGES: HeroMediaPage[] = [
  'homepage',
  'features',
  'markcopilot',
  'integrations',
  'solutions',
  'about',
];

/**
 * Empty by design: product UI is the default visual, not a bundled illustration.
 * A published CMS image can still choose a framed or full-bleed presentation.
 */
const cleanDefault = (): HeroMediaSettings => ({
  heroBackgroundImageUrl: '',
  heroBackgroundMobileImageUrl: '',
  heroBackgroundAlt: '',
  heroMediaMode: 'layered-preview',
  heroScrimStrength: 'subtle',
});

export const DEFAULT_HERO_MEDIA: Record<HeroMediaPage, HeroMediaSettings> = {
  homepage: cleanDefault(),
  features: cleanDefault(),
  markcopilot: cleanDefault(),
  integrations: cleanDefault(),
  solutions: cleanDefault(),
  about: cleanDefault(),
};

const modes: HeroMediaMode[] = ['layered-preview', 'editorial-backdrop', 'hybrid'];
const scrims: HeroScrimStrength[] = ['subtle', 'medium', 'strong'];
const safeLocal = /^\/media\/[A-Za-z0-9_\-/]+\.(?:avif|webp|png|jpe?g|svg)$/i;
const retiredEditorial = /\/media\/editorial\/(?:social-ecosystem-hand|ai-whatsapp-bot-concept|questions-support-portrait)(?:-[a-z0-9-]+)?\.(?:webp|png|jpe?g|avif)$/i;

/** Check ASCII controls without a control-character regex (ESLint no-control-regex). */
function isControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 32 || code === 127;
}

export function sanitizeHeroMediaUrl(input: unknown, extraTrustedHost = ''): string {
  if (typeof input !== 'string') return '';
  const value = input.trim();
  // Retire old clipart even when an earlier CMS draft cached its former URL.
  if (retiredEditorial.test(value)) return '';
  if (
    !value ||
    value.length > 2048 ||
    Array.from(value).some((char) => char === '\\' || isControlCharacter(char))
  )
    return '';
  if (value.startsWith('/')) {
    if (
      !safeLocal.test(value) ||
      value.includes('//') ||
      value.split('/').some((x) => x === '..' || x === '.')
    ) {
      return '';
    }
    return value;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port)
      return '';
    if (!/\.(?:avif|webp|png|jpe?g|svg)$/i.test(url.pathname)) return '';
    const hosts = new Set(['markchat.co.ke', 'www.markchat.co.ke']);
    if (extraTrustedHost) {
      const approved = new URL(extraTrustedHost);
      if (approved.protocol === 'https:' && !approved.username && !approved.password) {
        hosts.add(approved.hostname.toLowerCase());
      }
    }
    return hosts.has(url.hostname.toLowerCase()) ? url.href : '';
  } catch {
    return '';
  }
}

export function normalizeHeroMedia(
  page: HeroMediaPage,
  provided: Partial<HeroMediaSettings> | null | undefined,
  extraTrustedHost = ''
): HeroMediaSettings {
  const defaults = DEFAULT_HERO_MEDIA[page];
  const raw = { ...defaults, ...(provided || {}) };
  const desktop = sanitizeHeroMediaUrl(raw.heroBackgroundImageUrl, extraTrustedHost);
  const mobile = sanitizeHeroMediaUrl(raw.heroBackgroundMobileImageUrl, extraTrustedHost);
  const hasPicture = Boolean(desktop || mobile);
  return {
    heroBackgroundImageUrl: desktop,
    heroBackgroundMobileImageUrl: mobile,
    heroBackgroundAlt:
      typeof raw.heroBackgroundAlt === 'string'
        ? Array.from(raw.heroBackgroundAlt)
            .filter((char) => char !== '<' && char !== '>' && !isControlCharacter(char))
            .join('')
            .trim()
            .slice(0, 180)
        : '',
    heroMediaMode: hasPicture
      ? modes.includes(raw.heroMediaMode)
        ? raw.heroMediaMode
        : 'hybrid'
      : 'layered-preview',
    heroScrimStrength: scrims.includes(raw.heroScrimStrength)
      ? raw.heroScrimStrength
      : defaults.heroScrimStrength,
  };
}

export function serializeHeroMedia(page: HeroMediaPage, data: Partial<HeroMediaSettings>): string {
  return JSON.stringify(normalizeHeroMedia(page, data));
}

export function deserializeHeroMedia(page: HeroMediaPage, raw: string): HeroMediaSettings {
  try {
    const data = JSON.parse(raw);
    return normalizeHeroMedia(page, data && typeof data === 'object' ? data : null);
  } catch {
    return normalizeHeroMedia(page, null);
  }
}
