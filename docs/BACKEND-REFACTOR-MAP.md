# Backend refactor map

Prepared before splitting `server.js`. This document is an inventory only: it does not change runtime behavior.

## Current composition

The Railway backend is still assembled in `server.js`, with these existing extracted modules already in use:

- `render-service.js` — render service used by `/render` and Desktop.
- `desktop.js` — mounted under `/api/desktop`.
- `publication.js` — publication service and publication database setup.
- `stripe.js` — Stripe API helpers.

The shared PostgreSQL pool is created in `server.js` from `DATABASE_URL`.

## Shared runtime state and services

| Shared dependency | Current responsibility | Future home |
| --- | --- | --- |
| `db` | Shared PostgreSQL Pool used by account, connections, bots, billing, Desktop and setup | `database/db.js` |
| `desktopDatabaseReady` | Global readiness flag used by health and Desktop | `database/readiness.js` or setup module |
| `renders` | In-memory temporary render registry | `render/render-store.js` |
| `deleteFile`, `deleteRender`, `scheduleRenderCleanup` | Temporary media cleanup and TTL | `render/render-store.js` |
| `renderAudio` | FFmpeg render service from `render-service.js` | keep existing service |
| `withRenderCapacity` | Global/per-user render concurrency limits | `render/render-capacity.js` |
| `upload` | Multer temp upload middleware, 200 MB limit | `middleware/upload.js` |
| `publicationService` | Cross-platform publication service | keep `publication.js` |
| `desktopHandlers` | Bridges legacy provider publication handlers into Desktop publication | publication/legacy bridge |
| `getAccountFromRequest` | Bearer account-session authentication | `account/account-auth.js` |
| `isValidInternalRequest` | Internal secret authentication | `middleware/internal-auth.js` |
| Stripe synchronization helpers | Canonical subscription state and webhook reconciliation | `billing/stripe-service.js` / existing `stripe.js` |
| Telegram helpers | Bot API file/message send and permission validation | `telegram/telegram-service.js` |
| Discord helpers | request verification, permissions and command registration | `discord/discord-service.js` |
| provider upload URL validators | Restrict TikTok/YouTube upload destinations | provider publication service |
| account email/password helpers | Password hashing, verification/reset codes, rate limiting and email delivery | `account/account-service.js` |
| Google login helpers | state/verifier hashing, cookie parsing and account exchange | `account/google-auth-service.js` |

## Route → future module matrix

### Health and readiness

| Route | Future module | Main dependencies |
| --- | --- | --- |
| `GET /` | `routes/health-routes.js` | readiness flag, `renders.size` |
| `GET /health/live` | `routes/health-routes.js` | none |
| `GET /health/ready` | `routes/health-routes.js` | readiness flag |

### Desktop

The existing `createDesktopRouter()` is already modular and should remain mounted from `server.js`.

| Route group | Future module | Main dependencies |
| --- | --- | --- |
| `/api/desktop/*` | existing `desktop.js` | `db`, account auth, render service/store, publication service, FFmpeg executor, readiness, public backend URL |

Current mounted Desktop routes include:

- `POST /api/desktop/authorize`
- `GET /api/desktop/request/:code`
- `POST /api/desktop/approve`
- `POST /api/desktop/token`
- `GET /api/desktop/credentials`
- `DELETE /api/desktop/credentials/:id`
- `POST /api/desktop/revoke`
- `DELETE /api/desktop/connections/instagram`
- `POST /api/desktop/upload`
- `GET /api/desktop/renders/:id`
- `DELETE /api/desktop/renders/:id`
- `POST /api/desktop/publication`
- `GET /api/desktop/publications/:id`
- `GET /api/desktop/connections`
- `POST /api/desktop/publish-review`
- `POST /api/desktop/publication-login`
- `POST /api/desktop/publish-preview`
- `GET /api/desktop/publish`
- `GET /api/desktop/publish.css`
- `GET /api/desktop/publish.js`
- `POST /api/desktop/publish-confirm`
- `POST /api/desktop/publish-cancel`
- `GET /api/desktop/platform-render/:id`
- `GET /api/desktop/connect`
- `GET /api/desktop/connect.css`
- `GET /api/desktop/connect.js`

### Render and temporary media

| Route | Future module | Main dependencies |
| --- | --- | --- |
| `POST /render` | `routes/render-routes.js` | account auth, Multer, `renderAudio`, render capacity, temp-file cleanup |
| `POST /prepare-video` | `routes/render-routes.js` | account auth, Multer, FFmpeg executor, render capacity, `renders`, cleanup |
| `GET /render/:renderId` | `routes/render-routes.js` | `renders`, filesystem, render TTL |
| `GET /public-render/:renderId.mp4` | `routes/render-routes.js` | `renders`, filesystem |
| `DELETE /render/:renderId` | `routes/render-routes.js` | `deleteRender` |

The middleware preventing account-owned Desktop renders from entering legacy `/render` or `/public-render` routes belongs with render middleware/store rather than a provider route.

### Legacy direct provider publication

These remain separate from account connection management. They operate on temporary renders and are also assigned into `desktopHandlers`.

| Route | Future module | Main dependencies |
| --- | --- | --- |
| `POST /upload-tiktok` | `routes/legacy-publication-routes.js` | `renders`, TikTok upload URL validation, provider upload |
| `POST /upload-youtube` | `routes/legacy-publication-routes.js` | `renders`, YouTube upload URL validation, provider upload |

### Telegram

| Route | Future module | Main dependencies |
| --- | --- | --- |
| `POST /telegram/connect-code` | `routes/telegram-routes.js` | account auth, `db`, Telegram bot token/API, admin/creator validation |
| `GET /telegram/connect-status` | `routes/telegram-routes.js` | account auth, `db` |
| `POST /telegram/webhook` | `routes/telegram-routes.js` | webhook secret, `db`, Telegram permission checks |
| `POST /publish-telegram` | `routes/telegram-routes.js` | account auth, `db`, `renders`, FFmpeg/file helpers, Telegram Bot API |
| `DELETE /account/telegram/connection` | `routes/telegram-routes.js` | account auth, `db` |

### Discord

| Route | Future module | Main dependencies |
| --- | --- | --- |
| `POST /discord/connect-code` | `routes/discord-routes.js` | account auth, `db` |
| `GET /discord/connect-status` | `routes/discord-routes.js` | account auth, `db` |
| `POST /discord/interactions` | `routes/discord-routes.js` | raw request body, Discord signature verification, permission checks, `db` |
| `POST /publish-discord` | `routes/discord-routes.js` | account auth, `db`, `renders`, FFmpeg/file helpers, Discord Bot API |
| `DELETE /account/discord/connection` | `routes/discord-routes.js` | account auth, `db` |

Discord command registration should move with the Discord service/startup integration, not remain inside the central server file.

### Account-scoped provider OAuth transaction

| Route | Future module | Main dependencies |
| --- | --- | --- |
| `POST /account/oauth/start` | `routes/platform-oauth-routes.js` | account auth, crypto, `db` |
| `POST /account/oauth/complete` | `routes/platform-oauth-routes.js` | internal auth, crypto, transaction lock, `db`, provider connection tables |

This is the shared account-owned OAuth transaction layer for YouTube, TikTok and Instagram; provider-specific Vercel callbacks should continue consuming it.

### Email/password account routes

| Route | Future module | Main dependencies |
| --- | --- | --- |
| `POST /account/email/register` | `routes/account-routes.js` | `db`, password hashing, verification-code service |
| `POST /account/email/verify` | `routes/account-routes.js` | `db`, verification-code transaction, session creation |
| `POST /account/email/resend` | `routes/account-routes.js` | `db`, verification email service |
| `POST /account/password/forgot` | `routes/account-routes.js` | `db`, reset-code service |
| `POST /account/password/verify` | `routes/account-routes.js` | `db`, reset-token transaction |
| `POST /account/password/reset` | `routes/account-routes.js` | `db`, password hashing, reset-token transaction |
| `POST /account/email/login` | `routes/account-routes.js` | `db`, password verification, login rate limiting, session creation |
| `GET /account/me` | `routes/account-routes.js` | account auth, `db`, subscription state / Stripe price lookup |
| `POST /account/logout` | `routes/account-routes.js` | bearer token hashing, `db` |

### Google account authentication

| Route | Future module | Main dependencies |
| --- | --- | --- |
| `POST /account/google/exchange` | `routes/google-auth-routes.js` | `db`, verifier challenge, one-time exchange transaction |
| `GET /account/google` | `routes/google-auth-routes.js` | Google client ID, state/challenge transaction, backend callback URL |
| `GET /account/google/callback` | `routes/google-auth-routes.js` | Google client ID/secret, cookies/state, Google token/profile API, account link transaction |

Google account auth must stay separate from the YouTube/TikTok/Instagram connection OAuth layer.

### Billing / Stripe

| Route | Future module | Main dependencies |
| --- | --- | --- |
| `POST /stripe/webhook` | `routes/stripe-routes.js` | raw body, webhook signature verification, `db`, subscription reconciliation |
| `POST /stripe/create-portal-session` | `routes/stripe-routes.js` | account auth, `db`, Stripe billing portal helper |
| `POST /stripe/create-checkout-session` | `routes/stripe-routes.js` | account/internal auth, `db`, checkout helper, existing-subscription/portal logic |

The raw-body capture currently configured at the Express JSON middleware must continue covering `/stripe/webhook`.

### Stored YouTube connection

| Route | Future module | Main dependencies |
| --- | --- | --- |
| `POST /account/youtube/connection` | `routes/platform-connection-routes.js` | account/internal auth, `db` |
| `GET /account/youtube/connection` | `routes/platform-connection-routes.js` | account/internal auth, `db` |
| `PATCH /account/youtube/connection` | `routes/platform-connection-routes.js` | account/internal auth, `db` |
| `DELETE /account/youtube/connection` | `routes/platform-connection-routes.js` | account/internal auth, `db` |

### Stored TikTok connection

| Route | Future module | Main dependencies |
| --- | --- | --- |
| `POST /account/tiktok/connection` | `routes/platform-connection-routes.js` | account/internal auth, `db` |
| `GET /account/tiktok/connection` | `routes/platform-connection-routes.js` | account/internal auth, `db` |
| `PATCH /account/tiktok/connection` | `routes/platform-connection-routes.js` | account/internal auth, `db` |
| `DELETE /account/tiktok/connection` | `routes/platform-connection-routes.js` | account/internal auth, `db` |

### Stored Instagram connection and token-refresh lease

| Route | Future module | Main dependencies |
| --- | --- | --- |
| `POST /account/instagram/connection` | `routes/platform-connection-routes.js` | account/internal auth, `db` |
| `GET /account/instagram/connection` | `routes/platform-connection-routes.js` | account/internal auth, `db` |
| `PATCH /account/instagram/connection` | `routes/platform-connection-routes.js` | account/internal auth, `db` |
| `DELETE /account/instagram/connection` | `routes/platform-connection-routes.js` | account/internal auth, `db` |
| `POST /account/instagram/refresh-lease` | `routes/platform-connection-routes.js` | account/internal auth, `db`, refresh lease |
| `POST /account/instagram/refresh-release` | `routes/platform-connection-routes.js` | account/internal auth, `db`, refresh lease |

### Meta compliance callbacks

| Route | Future module | Main dependencies |
| --- | --- | --- |
| `POST /internal/meta/deauthorize` | `routes/meta-compliance-routes.js` | internal auth, `db`, Instagram connection deletion |
| `POST /internal/meta/data-deletion` | `routes/meta-compliance-routes.js` | internal auth, `db`, deletion-request tracking |
| `GET /internal/meta/data-deletion/:confirmationCode` | `routes/meta-compliance-routes.js` | `db` |

## Cross-cutting middleware that must not be lost

1. Express trusts one proxy: `app.set('trust proxy', 1)`.
2. JSON body limit is 1 MB.
3. Raw JSON body is preserved for:
   - `/discord/interactions`
   - `/stripe/webhook`
4. CORS currently allows all origins and exposes `X-Render-Id`.
5. Multer temporary uploads are capped at 200 MB.
6. Account-owned Desktop renders are hidden from legacy render/public-render endpoints.
7. Render capacity is currently process-local:
   - global default: 2 concurrent jobs;
   - per-user default: 1 concurrent job.
8. Temporary render state is currently process-local and kept in the `renders` Map.

These are invariants for code movement; changing them would be a separate functional task.

## Configuration / secrets map

| Variable | Used for |
| --- | --- |
| `DATABASE_URL` | PostgreSQL pool |
| `PORT` | Railway HTTP listener |
| `BACKEND_PUBLIC_URL` | callbacks, Desktop public URLs, publication URLs |
| `ONECE_FRONTEND_URL` | frontend redirect/publication URLs |
| `ONECE_INTERNAL_SECRET` | trusted Vercel ↔ Railway internal requests |
| `MAX_GLOBAL_RENDER_JOBS` | global render capacity |
| `MAX_USER_RENDER_JOBS` | per-user render capacity |
| `GOOGLE_ACCOUNT_CLIENT_ID` | 1CE account Google OAuth |
| `GOOGLE_ACCOUNT_CLIENT_SECRET` | 1CE account Google OAuth callback |
| `RESEND_API_KEY` | verification/reset email delivery |
| `RESEND_FROM_EMAIL` | verification/reset sender |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature verification |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram webhook authentication |
| `DISCORD_APPLICATION_ID` | Discord command/API integration |
| `DISCORD_BOT_TOKEN` | Discord Bot API |
| `DISCORD_GUILD_ID` | Discord command registration target |
| `DISCORD_PUBLIC_KEY` | Discord interaction signature verification |

## Database setup currently concentrated in server.js

`setupDatabase()` currently creates/alters the schema for:

- `account_users`
- `account_email_verifications`
- `account_password_resets`
- `account_sessions`
- `account_login_attempts`
- `account_google_login_attempts`
- `account_oauth_transactions`
- `youtube_connections`
- `tiktok_connections`
- `instagram_connections`
- `meta_data_deletion_requests`
- `stripe_subscriptions`
- `stripe_webhook_events`
- `telegram_connections`
- `telegram_connect_codes`
- `discord_connections`
- `discord_connect_codes`

It then delegates additional schema setup to:

- `setupDesktopDatabase(db)`
- `setupPublicationDatabase(db)`

The retry loop and readiness flag also currently live in `server.js`. Moving these is planned later; introducing a new formal migration system is not part of a pure refactor step.

## Proposed dependency direction

The target dependency direction for later steps is:

`server.js`
→ routes
→ services / auth / render helpers
→ database pool

Routes should not own database setup, application startup, or unrelated provider logic.

Services should not mount Express routes.

`server.js` should eventually retain only:

- app creation and global middleware;
- creation of shared services;
- router mounting;
- database initialization/startup;
- HTTP listener.

## Extraction safety rules

For every later route extraction:

1. move behavior without changing endpoint paths or response formats;
2. inject shared dependencies rather than importing `server.js`;
3. keep account and internal authentication requirements identical;
4. preserve transactions and `FOR UPDATE` locking exactly;
5. preserve raw-body handling for Stripe and Discord;
6. preserve render privacy/capacity rules;
7. run the full backend test suite after each extracted route group;
8. do not combine a structural move with a security or behavior change;
9. keep the existing `desktop.js`, `publication.js`, `render-service.js` and `stripe.js` contracts unless a separate task explicitly changes them.

## Planned extraction sequence

This map supports the previously agreed order:

1. health/readiness;
2. render routes;
3. account/email/password;
4. Google account OAuth;
5. platform connection storage / account OAuth transaction;
6. Telegram;
7. Discord;
8. Stripe/billing and Meta compliance where appropriate;
9. database setup/startup;
10. reduce `server.js` to composition.
