# Marketing CMS — direct and app-host subpath operation

Marketing supports two URL modes without modifying upstream Chatwoot Core:

1. Direct: `https://markchat.co.ke/dashboard/` — Astro assets under `/_astro/` and the configured `PUBLIC_BRIDGE_API_URL`.
2. Shared app host: `https://app.markchat.co.ke/_cms/dashboard/` — Nginx forwards the dashboard to the Marketing upstream, rewrites HTML asset links to `/_cms/_astro/`, and forwards its CMS Bearer API requests to `/_cms/api/`. Configure the authenticated CMS API service using `MC_CMS_API_UPSTREAM` on the Control Plane ingress renderer; a static-only Astro server does **not** implement that API.

The dashboard layout rewrites on-page dashboard links when mounted, and the CMS API chooses the same-origin prefix in that mode. Login redirects are restricted to dashboard paths and a returned CMS token is required (an entered passkey is never silently converted into a Bearer token). CMS sessions are **independent** from Control Plane Super Admin and Chatwoot Core sessions. The shared switcher provides navigation, not shared-password or shared-JWT sign-in.

Both repositories use `.gitattributes` to enforce LF text files after Git checkout on Windows, macOS and Linux.

## Verification (macOS zsh, Windows PowerShell, Linux)
```
git switch main
git pull --ff-only origin main
npm ci
npm run check
npm run build
npm test
```

For a direct local Astro preview: `npm run dev`, then open `http://localhost:4321/dashboard/`.

The shared ingress is tested separately from `markchat-control-plane` using `npm run test:ingress`. Real CMS backend authentication, UI navigation, CSP and signed-host integration still require a browser smoke test before production deployment.
