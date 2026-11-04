/**
 * Shared LIVE-PREVIEW OAuth client (server-only — NEVER import from the client).
 *
 * The sandbox serves each live preview on a dynamic `https://*.grok-sandbox.com`
 * URL, which can't be pre-registered per app. The broker instead exposes ONE
 * shared "preview" client that accepts any
 * `https://*.grok-sandbox.com/api/auth/callback/*`
 * (broker: `app-builder-deployer/auth/src/preview-oauth.ts`). Better Auth 1.7
 * initiates generic OAuth with `/api/auth/callback/:id` (the older path was
 * `/api/auth/oauth2/callback/:id`). Confirm the preview client's redirect
 * allowlist includes that new path before turning sign-in on.
 *
 * The client id is public. The client secret is never committed: read it from
 * `GROK_PREVIEW_CLIENT_SECRET`, or let `server.ts` use the deployer-injected
 * `GROK_AUTH_CLIENT_SECRET`. When auth is off, a missing secret is fine —
 * federated sign-in stays inactive.
 */
function env(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

export const PREVIEW_CLIENT_ID = env("GROK_PREVIEW_CLIENT_ID") ?? "grok_preview";
export const PREVIEW_CLIENT_SECRET = env("GROK_PREVIEW_CLIENT_SECRET");

/** The shared auth broker issuer (OIDC discovery lives under it). */
export const GROK_ISSUER_DEFAULT = "https://auth.grok.me";

/**
 * Host patterns whose callbacks the preview client accepts. Better Auth derives
 * the live preview's real origin from the request host and validates it against
 * this list (wildcard-matched), so the OAuth `redirect_uri` becomes the concrete
 * `https://<preview-host>/api/auth/callback/...`.
 */
export const PREVIEW_ALLOWED_HOSTS = ["*.grok-sandbox.com"] as const;
