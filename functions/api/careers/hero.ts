import { normalizeHeroMedia, sanitizeHeroMediaUrl } from '../../../src/lib/hero-media.ts';
import type { HeroMediaSettings } from '../../../src/lib/types';
import { requireCareersAdmin } from '../../../src/lib/server/careers-admin.ts';
import {
  httpJson,
  readJson,
  sameOrigin,
  type EdgeContext,
} from '../../../src/lib/server/edge-security.ts';

export async function onRequestGet(context: EdgeContext): Promise<Response> {
  if (!context.env.MARKCHAT_RATE_DB) return httpJson({ success: false }, 503);
  try {
    const row = await context.env.MARKCHAT_RATE_DB.prepare(
      'SELECT settings_json FROM markchat_career_hero WHERE id = ?'
    )
      .bind('careers')
      .first<{ settings_json: string }>();
    const settings = row ? JSON.parse(row.settings_json) : null;
    return httpJson(normalizeHeroMedia('careers', settings, context.env.CAREERS_MEDIA_ORIGIN));
  } catch {
    console.warn('CAREERS_HERO_READ_FAILED');
    return httpJson({ success: false }, 503);
  }
}

export async function onRequestPut(context: EdgeContext): Promise<Response> {
  if (!sameOrigin(context.request)) return httpJson({ success: false, error: 'Forbidden' }, 403);
  const denied = await requireCareersAdmin(context);
  if (denied) return denied;
  let data: unknown;
  try {
    data = await readJson(context.request, 8000);
  } catch {
    return httpJson({ success: false, error: 'Invalid settings' }, 400);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return httpJson({ success: false, error: 'Invalid settings' }, 400);
  const raw = data as Partial<HeroMediaSettings>;
  const keys = [
    'heroBackgroundImageUrl',
    'heroBackgroundMobileImageUrl',
    'heroBackgroundAlt',
    'heroMediaMode',
    'heroScrimStrength',
    'heroFocalX',
    'heroFocalY',
    'heroMobileFocalX',
    'heroMobileFocalY',
  ];
  if (Object.keys(raw).some((key) => !keys.includes(key)))
    return httpJson({ success: false, error: 'Invalid settings' }, 400);
  for (const key of ['heroBackgroundImageUrl', 'heroBackgroundMobileImageUrl'] as const) {
    if (
      raw[key] !== undefined &&
      (typeof raw[key] !== 'string' ||
        (raw[key].trim() && !sanitizeHeroMediaUrl(raw[key], context.env.CAREERS_MEDIA_ORIGIN)))
    )
      return httpJson({ success: false, error: 'Use an approved image URL.' }, 400);
  }
  for (const key of ['heroFocalX', 'heroFocalY', 'heroMobileFocalX', 'heroMobileFocalY'] as const) {
    const value = raw[key];
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100)
    )
      return httpJson({ success: false, error: 'Focal points must be from 0 to 100.' }, 400);
  }
  const settings = normalizeHeroMedia('careers', raw, context.env.CAREERS_MEDIA_ORIGIN);
  if (
    (settings.heroBackgroundImageUrl || settings.heroBackgroundMobileImageUrl) &&
    !settings.heroBackgroundAlt
  )
    return httpJson({ success: false, error: 'Describe the image for accessibility.' }, 400);
  if (!context.env.MARKCHAT_RATE_DB)
    return httpJson({ success: false, error: 'Settings could not be saved.' }, 503);
  try {
    const result = await context.env.MARKCHAT_RATE_DB.prepare(
      `INSERT INTO markchat_career_hero (id, settings_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`
    )
      .bind('careers', JSON.stringify(settings), new Date().toISOString())
      .run();
    if (result.success !== true || result.meta?.changes !== 1) throw new Error('Unconfirmed write');
    return httpJson(settings);
  } catch {
    console.warn('CAREERS_HERO_WRITE_FAILED');
    return httpJson({ success: false, error: 'Settings could not be saved.' }, 503);
  }
}
