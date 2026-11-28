import {
  trustedHttpsBase,
  type EdgeContext,
} from '../../src/lib/server/edge-security.ts';

// This endpoint intentionally fails closed. It never assumes a static Astro
// build or seeded CMS job listing represents a live vacancy.
const CLOSED = Object.freeze({
  recruitmentOpen: false,
  talentPoolOpen: false,
  acceptingApplications: false,
  acceptingTalentPool: false,
  portalReady: false,
});

const noStoreHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};

export async function onRequestGet({ env }: EdgeContext): Promise<Response> {
  const base = trustedHttpsBase(env.CONTROL_PLANE_API_URL);
  if (!base) return new Response(JSON.stringify(CLOSED), { status: 200, headers: noStoreHeaders });
  try {
    const url = new URL('/api/public/careers/availability', base);
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error('Recruitment policy unavailable');
    const candidate: unknown = await response.json();
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      throw new Error('Invalid recruitment policy');
    const policy = candidate as Record<string, unknown>;
    const ready = policy.portalReady === true;
    const recruiting = ready && policy.recruitmentOpen === true && policy.acceptingApplications === true;
    const talent = recruiting && policy.talentPoolOpen === true && policy.acceptingTalentPool === true;
    return new Response(
      JSON.stringify({
        recruitmentOpen: recruiting,
        talentPoolOpen: talent,
        acceptingApplications: recruiting,
        acceptingTalentPool: talent,
        portalReady: ready,
      }),
      { status: 200, headers: noStoreHeaders },
    );
  } catch {
    return new Response(JSON.stringify(CLOSED), { status: 200, headers: noStoreHeaders });
  }
}
