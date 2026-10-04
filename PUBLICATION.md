# Desktop publication with browser confirmation

The desktop credential still has only `render:write`. It cannot invoke a platform upload or confirm a publication. `POST /api/desktop/publication` creates a ten-minute browser handoff for its own private render. The opaque ticket is stored hashed and travels in the browser URL fragment, never in a query string.

The browser signs into the same account via email/password or the existing Google flow, whose one-time state is bound to an HttpOnly browser cookie. It obtains account-owned destinations, previews the private video, edits title/description, selects destinations and explicitly confirms YouTube visibility. `POST /api/desktop/publish-confirm` requires both that account session and the handoff ticket. The server checks connection fingerprints again and atomically claims the pending request. Duplicate confirmations cannot start another upload.

The private MP4 remains available for ten minutes while pending. A confirmed job pins it during transfers. An Instagram media capability is issued only during that transfer and removed afterward. The public legacy render routes continue refusing all desktop renders.

## Existing platform behavior

- YouTube: existing resumable upload, public visibility for desktop publications, enforced server-side after browser confirmation. The site upload flow retains its previous public default. Upload-only OAuth may prevent showing a channel name; the review warns to check Connections.
- TikTok: existing `video.upload` inbox flow; the user must finish posting in TikTok. This is not Direct Post.
- Instagram: existing Reel container processing/publishing, with account-owned stored connection and a temporary private media URL rather than a public render.
- Telegram and Discord: existing cover + MP3 handlers, server-selected account-owned chat/channel. No claim of legacy clientId-only rows is attempted.

The database records individual outcomes. An interrupted process or uncertain provider response is never automatically retried, because the provider may have accepted the side effect. Inspect the platform before submitting a fresh upload. This version runs inside the Railway process and does not provide a durable background worker that resumes after a deploy.

## Deployment and configuration

Deploy the companion `tofdidthat/autoshorts` internal endpoint `/api/desktop/publish` first, then this Railway backend. Its rewrite dispatches through the existing upload-chunk function to `lib/desktop-publish.js`, keeping twelve Vercel functions and preserving normal chunk uploads. Both servers use the existing shared `ONECE_INTERNAL_SECRET`. Vercel retains existing OAuth secrets; none are sent to the desktop. Set Railway `ONECE_FRONTEND_URL` to the canonical HTTPS site origin where that internal endpoint is served without redirects. The fallback is `https://1ce.lol`; Vercel `ONECE_BACKEND_URL` must be the Railway HTTPS origin. The Vercel bridge has maxDuration 300 seconds, matching existing Instagram processing.

Telegram account linking requires Railway `TELEGRAM_WEBHOOK_SECRET` and the identical Telegram `setWebhook` `secret_token`. Configure this before reconnecting through Connections. Generate a private random value, keep it server-side, and use the existing bot token with Telegram's setWebhook endpoint. The webhook URL is the existing Railway `/telegram/webhook`. Do not place either secret in logs or browser requests.

After upgrading, sign into the site and reconnect Telegram/Discord to associate their new connection codes with `account_users`. Existing legacy site connections continue working. Disconnecting through Connections removes the account connection and outstanding codes. Destinations without a secure connection or required service configuration are disabled in the review.

## Validation

`npm test` uses real PostgreSQL-compatible PGlite SQL and real FFmpeg/ffprobe. Provider HTTP calls are mocked: no content is published by the tests. Coverage includes existing rendering/preparation, private media, authorization, five-provider transfers after consent, changed connections, duplicate confirmation, revocation, cancellation, process-interruption state, bot account linking and Telegram webhook authentication. Companion site tests exercise internal authorization, sanitized identities, explicit YouTube privacy and TikTok initialization.

## App frontend handoff

Desktop confirmation uses the existing https://1ce.lol/app frontend. Existing installers continue receiving the same backend handoff origin; its landing page transfers the opaque ticket in a URL fragment to the canonical frontend. The app removes it from the address and keeps it in tab-scoped sessionStorage keyed by request id. Login and connection OAuth returns preserve the pending request. Google publication authorization uses a distinct publishapp state and returns only the 1CE account session to the app, never platform OAuth credentials. Confirmation still requires an account session plus ticket and server-side connection fingerprints; legacy site generation and uploads are unchanged.
