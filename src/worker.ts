import { onRequestPost as apply } from '../functions/api/careers/apply';
import { onRequestGet as listApplications } from '../functions/api/careers/applications';
import { onRequestPatch as updateApplication } from '../functions/api/careers/application';
import { onRequestGet as downloadCv } from '../functions/api/careers/cv';
import {
  onRequestGet as getCareersHero,
  onRequestPut as putCareersHero,
} from '../functions/api/careers/hero';
import type { EdgeEnv } from './lib/server/edge-security';
import { onRequestPost as handleLeadPost } from '../functions/api/leads';
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

    if (pathname === '/api/careers/apply') {
      return request.method === 'POST' ? apply(context) : methodNotAllowed('POST');
    }
    if (pathname === '/api/careers/hero') {
      if (request.method === 'GET') return getCareersHero(context);
      if (request.method === 'PUT') return putCareersHero(context);
      return methodNotAllowed('GET, PUT');
    }
    if (pathname === '/api/careers/applications') {
      return request.method === 'GET' ? listApplications(context) : methodNotAllowed('GET');
    }
    const application = pathname.match(/^\/api\/careers\/applications\/([^/]+)$/);
    if (application) {
      return request.method === 'PATCH'
        ? updateApplication(context, application[1])
        : methodNotAllowed('PATCH');
    }
    const cv = pathname.match(/^\/api\/careers\/cv\/([^/]+)$/);
    if (cv) {
      return request.method === 'GET' ? downloadCv(context, cv[1]) : methodNotAllowed('GET');
    }

    if (pathname === '/api/leads') {
      if (request.method === 'POST') return handleLeadPost(context);
      return methodNotAllowed('POST');
    }

    return env.ASSETS.fetch(request);
  },
};
