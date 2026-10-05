# Export / Upload 1ce — backend stage 1

This stage creates temporary videos only. It does not publish, and does not change the Windows program.

## Railway configuration

Use the existing PostgreSQL `DATABASE_URL` and set `BACKEND_PUBLIC_URL` to the public **HTTPS** Railway origin (no path). Existing Google account login configuration is reused: `GOOGLE_ACCOUNT_CLIENT_ID`, `GOOGLE_ACCOUNT_CLIENT_SECRET`, and the registered `/account/google/callback` redirect URI. Email/password login also works for verified 1CE accounts.

The existing startup migration creates three additional tables without altering existing account or platform data. Desktop endpoints return 503 until the migration succeeds. Renders keep the existing in-memory registry and ten-minute cleanup, so the current single-process / single-replica deployment assumption still applies. Restarting the service removes access to temporary renders; credentials and authorization requests persist in PostgreSQL.

## First connection

1. The future desktop client generates a fresh cryptographically random PKCE verifier (43–128 URL-safe characters), and its base64url-encoded SHA-256 challenge.
2. `POST /api/desktop/authorize` with JSON:
   ```json
   {"device_name":"Studio PC","code_challenge":"<S256 challenge>","code_challenge_method":"S256"}
   ```
   The response includes `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in: 600`, and `interval: 5`. The desktop displays the user code and opens the complete verification URL in the system browser. Keep the device code and verifier inside the desktop process; neither belongs in the browser URL.
3. The backend-hosted browser page displays the device name and matching code. The user signs into 1CE using Google or email/password, checks the displayed account, then explicitly authorizes or refuses. Google states are bound to an HttpOnly, Secure, SameSite=Lax browser cookie, expire after ten minutes, and can be consumed only once. The account session remains in browser memory; it is never returned by the desktop exchange.
4. Poll `POST /api/desktop/token` with `device_code` and `code_verifier`, no faster than every five seconds. Pending requests return HTTP 400 `authorization_pending`; HTTP 429 `slow_down` means wait at least the returned interval. Refusal returns `access_denied`; expired, consumed, or invalid requests return `invalid_grant` and require a new authorization. Respect HTTP 429 on any authorization route.
5. Approval returns a separate `1ce_desktop_…` Bearer token, `credential_id`, `expires_at` (90 days), and `scope: render:write`. Redemption and token creation use one PostgreSQL transaction with a locked authorization row, so a request can issue only one credential. Tokens are stored as SHA-256 hashes. The future Windows client should save the token in Windows Credential Manager; reauthorize after expiration or revocation. No platform OAuth token or refresh token is included.

User codes are short, random, and valid for ten minutes. Initiation, code lookup, approval and polling have a bounded, per-process IP limiter. This is supplementary protection; the long device code plus PKCE proof protects redemption. A shared rate limiter would be needed if this service later moves to multiple replicas (together with shared render storage).

## Upload and temporary video

`POST /api/desktop/upload` with `Authorization: Bearer <desktop credential>` and multipart fields:

- `audio`: required MP3, checked with ffprobe rather than trusting extension/MIME.
- `cover`: optional JPG, PNG or WEBP, also checked with ffprobe.

There are at most two files, no text fields, and a 200 MiB limit per file. One upload per account can run at a time in this process. Inputs are deleted after validation/rendering, including error paths. Render processes have a ten-minute timeout; probe processes have a fifteen-second timeout.

The endpoint calls the same render service as `/render`. Without cover, FFmpeg supplies a black 720×1280 source. The result is H.264/AAC MP4, retained for ten minutes using the existing cleanup. Example response (HTTP 201):

```json
{"ok":true,"renderId":"<uuid>","size":12345,"mimeType":"video/mp4","expiresInSeconds":600,"published":false}
```

Download using `GET /api/desktop/renders/:id`; remove using `DELETE /api/desktop/renders/:id`. Both require an active desktop credential for the owning account. Other accounts receive 404. Desktop-owned renders are rejected by legacy render/public-download/publication routes, including YouTube/TikTok/Telegram/Discord, until a later authenticated publishing stage is designed.

## Revocation

- `GET /api/desktop/credentials` with an existing **account session** lists devices and expiration/revocation metadata, never tokens or hashes.
- `DELETE /api/desktop/credentials/:id` with an account session revokes only a credential owned by that account.
- `POST /api/desktop/revoke` with a desktop credential revokes itself.

Revocation and expiration are checked on each desktop request. Account sessions cannot authenticate desktop uploads; desktop tokens cannot authenticate account endpoints or the internal platform connection API. Deleting an account cascades to its credentials and authorization records. Account logout ends that browser session; desktop authorization is separate and must be revoked explicitly.

## Existing connections and boundaries

The inspected schema has `youtube_connections`, `tiktok_connections`, and `instagram_connections` linked through a unique `user_id` foreign key to `account_users`. Their account storage endpoints require both a valid 1CE account session and the existing internal-service secret. This establishes account ownership in storage, but does not establish a complete server-side publishing flow or token refresh policy. Those must be reviewed with the frontend/platform integrations before desktop publication is added.

Legacy `/render` still requires cover + audio and streams MP4 with `X-Render-Id`. `/prepare-video` retains the existing remux/audio replacement behavior. Existing platform upload handlers and Telegram/Discord connection authentication were not rewritten.

## Validation

Run `npm ci` followed by `npm test` (Node 22). Development dependencies provide an embedded PostgreSQL engine (PGlite) and real ffmpeg/ffprobe binaries; production dependencies stay unchanged. Tests exercise the real Express server and SQL schema, proof/consent/replay protection, Google browser binding and callback routing (provider responses mocked), media validation, black frame pixels, 9:16 dimensions and audio codec, embedded MP3 artwork, private render boundaries, revocation, and both `/prepare-video` paths. No live platform publication, Google OAuth round trip or production database mutation is part of the local suite. The GitHub workflow runs the suite on Linux for pushes to main and pull requests.

## Saved stems
Desktop uploads may include a third multipart file, `stems`, alongside `audio` and optional `cover`. The ZIP is limited to 500 MB compressed, 2 GB expanded and 2,048 entries; it must contain WAV audio only. Validation reads each entry without extracting it, checks WAV headers and CRC, and rejects unsafe paths, links, encrypted entries and damaged archives.

Audio and stems are committed together to the owner's account. Duplicate audio is deduplicated per account; supplying a new ZIP replaces the attached stems atomically, while an audio-only retry preserves existing stems. Account-authenticated `GET /api/desktop/beats` includes `stems_name` and `stems_size`. `GET /api/desktop/beats/:id/stems` downloads the owner's ZIP, supports ranges and returns 404 to other accounts. Downloads use a repeatable-read snapshot so a concurrent ZIP replacement cannot mix versions. Neither asset depends on temporary renders or publication confirmation.

Windows 2.3.1 exports `stems - [FLP basename]` and `stems - [FLP basename].zip`. Only that project-specific ZIP is attached automatically; legacy generic `stems.zip` files are left untouched. The update changes scripts while retaining the existing native context-menu package and desktop credential.
