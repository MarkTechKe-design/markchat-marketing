import type { EdgeEnv } from './lib/server/edge-security';
import { onRequestPost as handleLeadPost } from '../functions/api/leads';
import { onRequestGet as handleCareersAvailabilityGet } from '../functions/api/careers-availability';
import { listPublicRoles, getPublicRole, submitApplication } from '../functions/api/careers';
import {
  onRequestGet as handleMarkcopilotGet,
  onRequestPost as handleMarkcopilotPost,
} from '../functions/api/markcopilot';

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface WorkerEnv extends EdgeEnv {
  ASSETS: AssetFetcher;
}

function methodNotAllowed(allowed: string): Response {
  return new Response(JSON.stringify({ success: false, error: 'Method Not Allowed' }), {
    status: 405,
    headers: {
      Allow: allowed,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    const context = { request, env };

    if (pathname === '/api/markcopilot') {
      if (request.method === 'GET') return handleMarkcopilotGet(context);
      if (request.method === 'POST') return handleMarkcopilotPost(context);
      return methodNotAllowed('GET, POST');
    }

    if (pathname === '/api/careers/availability') {
      if (request.method === 'GET') return handleCareersAvailabilityGet(context);
      return methodNotAllowed('GET');
    }

    if (pathname === '/api/careers/roles') {
      if (request.method === 'GET') return listPublicRoles(context);
      return methodNotAllowed('GET');
    }
    const rolePath = pathname.match(/^\\/api\\/careers\\/roles\\/([a-z0-9-]+)$/);
    if (rolePath) {
      if (request.method === 'GET') return getPublicRole(context, rolePath[1]);
      return methodNotAllowed('GET');
    }
    if (pathname === '/api/careers/apply') {
      if (request.method === 'POST') return submitApplication(context);
      return methodNotAllowed('POST');
    }

    if (pathname === '/api/leads') {
      if (request.method === 'POST') return handleLeadPost(context);
      return methodNotAllowed('POST');
    }

    // Runtime role URLs are only served when the authoritative backend confirms
    // an active, published vacancy. Never resurrect seeded static JobPosting pages.
    const publicJobPath = pathname.match(/^\\/careers\\/([a-z0-9-]+)$/);
    if (publicJobPath && publicJobPath[1] !== 'position') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return methodNotAllowed('GET, HEAD');
      }
      const roleResponse = await getPublicRole(context, publicJobPath[1]);
      if (!roleResponse.ok) {
        return new Response('Position unavailable', {
          status: 404,
          headers: { 'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
        });
      }
      const data = await roleResponse.json() as {
        success: boolean;
        role?: { title?: string; description?: string; applicationDeadline?: string;
          postedDate?: string; slug?: string; location?: string };
      };
      const role = data.role;
      if (!role || typeof role.title !== 'string' || typeof role.description !== 'string') {
        return new Response('Position unavailable', { status: 404 });
      }
      const assetRequest = new Request(new URL('/careers/position/', request.url), request);
      const template = await env.ASSETS.fetch(assetRequest);
      if (!template.ok) return new Response('Careers template unavailable', { status: 503 });
      const escapeHtml = (value: string) =>
        value.replace(/[&<>"']/g, (ch) =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] || '');
      const title = escapeHtml(role.title) + ' — MarkChat Careers';
      const schema = {
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: role.title,
        description: role.description,
        datePosted: role.postedDate || undefined,
        validThrough: role.applicationDeadline || undefined,
        hiringOrganization: {
          '@type': 'Organization',
          name: 'MarkChat',
          sameAs: 'https://markchat.co.ke',
        },
        jobLocation: {
          '@type': 'Place',
          address: { '@type': 'PostalAddress', addressCountry: 'KE',
            addressLocality: role.location || 'Kenya' },
        },
      };
      const jobPostingScript = '<script type="application/ld+json">' +
        JSON.stringify(schema).replace(/</g, '\\u003c') + '</script>';
      let html = await template.text();
      html = html.replace(/<title>[^<]*<\\/title>/i, '<title>' + title + '</title>');
      html = html.replace(/<meta\\s+name="robots"[^>]*>/i, '');
      html = html.replace('</head>', jobPostingScript + '</head>');
      const headers = new Headers(template.headers);
      headers.set('Content-Type', 'text/html; charset=utf-8');
      headers.set('Cache-Control', 'no-store, max-age=0');
      headers.delete('Content-Length');
      headers.delete('Content-Encoding');
      headers.delete('ETag');
      headers.delete('X-Robots-Tag');
      return new Response(request.method === 'HEAD' ? null : html, { status: 200, headers });
    }

    return env.ASSETS.fetch(request);
  },
};
