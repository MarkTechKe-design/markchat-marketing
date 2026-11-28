import type { EdgeEnv } from './lib/server/edge-security';
import { onRequestPost as handleLeadPost } from '../functions/api/leads';
import { onRequestGet as handleCareersAvailabilityGet } from '../functions/api/careers-availability';
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

    if (pathname === '/api/leads') {
      if (request.method === 'POST') return handleLeadPost(context);
      return methodNotAllowed('POST');
    }

    return env.ASSETS.fetch(request);
  },
};
