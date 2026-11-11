# @klipz/publishers

Social publishing adapters for KLIPZ (personal, single-user, local). Zero deps beyond `zod`, global `fetch`, `node:crypto`, `node:fs`. All HTTP goes through `ctx.fetch ?? globalThis.fetch`, so tests never touch the network.

Renders are local files, so every adapter's default path is a direct binary (chunked) upload through an `AssetSource` (`size` + `readChunk(start,end)`, backed by `node:fs` for `filePath` or a Range fetch for `url`), keeping memory bounded. URL-pull modes are used only when `render.url` is set and no `filePath` exists (TikTok additionally needs `config.extra.tiktokSource === 'pull'`).

```ts
import { getPublisher, ensureFreshTokens, composeCaption } from '@klipz/publishers';
const pub = getPublisher('youtube', { aggregator });            // aggregator optional
const url = pub.getAuthUrl(ctx, { state, codeChallenge });
const { tokens, accounts, accountTokens } = await pub.connect(ctx, { code, codeVerifier });
const fresh = await ensureFreshTokens(pub, ctx, tokens);        // skewSec = 300
const issues = pub.validate(render, meta, account);             // pure, never throws
const res = await pub.publish(ctx, { tokens: fresh, account, render, meta });
```

Errors are `PublishError { code, retryable, needsReconnect, retryAfterSec?, providerPayload? }`. 401/invalid token maps to `needsReconnect`; 429/5xx to `retryable` (honouring `Retry-After`). Polling is capped (`config.extra.pollMaxAttempts`) and returns `status: 'processing'` instead of blocking; use `getStatus` later.

## Redirect URIs

Register `http://localhost:3000/api/oauth/{provider}/callback` where `{provider}` is `youtube | tiktok | instagram | facebook | x | linkedin`. Instagram and Facebook share the Meta app; register both callbacks.

Platforms that reject `http://localhost` redirects: **TikTok (web Login Kit requires HTTPS and a registered domain)**, and Meta apps once switched to Live mode (dev mode allows localhost). Workarounds: (a) run an HTTPS tunnel (cloudflared / ngrok) and set `APP_URL=https://your-tunnel.example` so redirect URIs become `${APP_URL}/api/oauth/{provider}/callback`; or (b) route that platform through the aggregator (`AGGREGATOR_PROVIDERS=tiktok`). Google accepts `http://localhost`; X and LinkedIn accept it for development apps.

## Environment variables (read by the web app)

| Variable | Purpose |
|---|---|
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` | Google OAuth client |
| `TIKTOK_CLIENT_ID` (client key) / `TIKTOK_CLIENT_SECRET` | TikTok app |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` | X OAuth 2.0 client |
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | LinkedIn app |
| `META_APP_ID` / `META_APP_SECRET` | Shared by instagram + facebook |
| `AGGREGATOR_KIND` | `upload-post` or `ayrshare` |
| `AGGREGATOR_API_KEY` | aggregator key |
| `AGGREGATOR_PROVIDERS` | comma list routed via aggregator, e.g. `tiktok,x` |
| `APP_URL` | public base URL (default `http://localhost:3000`) |
| `TIKTOK_AUDITED` | `true` once the TikTok app passed audit. Surfaced as `config.extra.tiktokAudited`; use `withTikTokAudited(account, ctx.config)` before `validate()`. When not `true` and privacy is not `SELF_ONLY`, validate() adds the warning `unaudited_app_forced_private` (non-blocking). |
| `KLIPZ_UPLOAD_MODE` | `buffer` sets `config.extra.uploadMode` (the KLIPZ web app maps it for Instagram, Facebook and aggregator-routed providers); restores whole-file in-memory uploads (Instagram/Facebook rupload, Upload-Post). |

`aggregatorConfigFromEnv(env)` builds an `AggregatorConfig` from these (plus optional `AGGREGATOR_PROFILE_KEY`, `AGGREGATOR_BASE_URL`).

## Per-platform setup, scopes, pre-approval behaviour

### YouTube
1. Google Cloud Console: new project, enable "YouTube Data API v3" (and YouTube Analytics API for metrics).
2. OAuth consent screen: External, Testing; add yourself as a test user (test tokens expire after 7 days, reconnect weekly).
3. Credentials: OAuth client "Web application", redirect URI above.
- Scopes: `youtube.upload`, `youtube.readonly`, `yt-analytics.readonly`. Offline access is requested (`access_type=offline`, `prompt=consent`).
- Before audit: videos uploaded by an unverified API project are **forced private** (locked) until the project passes the API compliance audit.
- Quota (docs checked 2026-11-11, https://developers.google.com/youtube/v3/determine_quota_cost): `videos.insert` now has its own bucket: each call costs 1 and the default is 100 inserts/day, separate from the 10,000 units/day for other endpoints (older material says 1,600 units per upload). Quota errors map to `quota_exceeded`, retryable, retry after midnight Pacific.

### TikTok
1. developers.tiktok.com: create app, add products "Login Kit" and "Content Posting API" (enable Direct Post). Add yourself as a Target User in Sandbox.
2. Scopes: `user.info.basic`, `video.publish`, `video.list`.
- Before audit: unaudited clients can only post `SELF_ONLY` (private) and are limited in daily posts. `validate()` enforces the audit-required UX: privacy level chosen explicitly (no default), consent accepted, branded content cannot be `SELF_ONLY`, and options must be within `getTikTokCreatorInfo()` results (privacy options, comment/duet/stitch disabled, max duration). The UI must show `TIKTOK_CONSENT_TEXT*` strings and the creator's nickname.
- FILE_UPLOAD chunked is the default; PULL_FROM_URL needs a verified URL prefix.

### Instagram (Reels)
1. developers.facebook.com: create a Business app, add "Facebook Login for Business" (or Facebook Login). Instagram account must be Professional (Business/Creator) and linked to a Facebook Page.
2. Scopes: `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`, `business_management`.
- Development mode works for accounts with a role (admin/developer/tester) on the app, no review needed. Publishing limit about 100 API posts per 24h (checked via `content_publishing_limit`). Reels 3-90s recommended (up to 15 min allowed).

### Facebook Page Reels
Same Meta app. Scopes: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `read_insights`, `business_management`. Page tokens come back via `accountTokens` (keyed by page id). Dev mode works for pages you manage with a role on the app.

### X
1. developer.x.com: project + app, enable OAuth 2.0 (Web App / confidential), redirect URI above.
2. Scopes: `tweet.read tweet.write users.read media.write offline.access`.
- Posting with media requires a paid tier or pay-per-use credits; the free tier fails with 403 which maps to `tier_required`. 429 uses `x-rate-limit-reset` for `retryAfterSec`. Text limit 280 weighted chars.

### LinkedIn
1. linkedin.com/developers: create app (needs a Company Page), add product **"Share on LinkedIn"** (grants `w_member_social`) and "Sign In with LinkedIn using OpenID Connect" (`openid profile`).
2. Posting to organizations needs Community Management API (`w_organization_social`), which requires review; not enabled by default.
- Uses Videos API (`/rest/videos?action=initializeUpload`, PUT parts collecting ETags, finalize, wait AVAILABLE) then `/rest/posts`, with `LinkedIn-Version` and `X-Restli-Protocol-Version: 2.0.0`. Post id comes from `x-restli-id`.
- Metrics: member post analytics need `r_member_social`, which is restricted; `fetchMetrics` returns what is accessible and otherwise empty values with `raw`. Treat LinkedIn metrics as best-effort.

### Aggregator (optional)
`AggregatorConfig { kind: 'upload-post' | 'ayrshare', apiKey, baseUrl?, providers[], profileKey? }`. Providers listed are routed through the service: publish, getStatus and fetchMetrics are delegated; `connect` returns a synthetic account; `validate` reuses the native validator. Useful for TikTok when no HTTPS domain is available, or to skip audits (the aggregator's own app is already approved).

## App review checklist (only needed for posting to other people's accounts / public visibility)
- [ ] **TikTok**: submit app for audit with demo video showing the Direct Post UX (creator info, privacy picker with no default, comment/duet/stitch toggles, commercial-content disclosure, consent text). Until approved, everything posts `SELF_ONLY`.
- [ ] **Meta**: business verification; App Review for `instagram_content_publish`, `instagram_manage_insights`, `pages_manage_posts`, `pages_read_engagement` (screencast + test credentials); switch app to Live. Not needed for your own role accounts in dev mode.
- [ ] **YouTube**: OAuth app verification (sensitive scopes) plus YouTube API Services compliance audit to lift the forced-private restriction; request quota extension above 10k units/day if needed.
- [ ] **X**: subscribe to a paid tier or enable pay-per-use credits to post media.
- [ ] **LinkedIn**: "Share on LinkedIn" self-serve; Community Management API review for company pages.

## Streaming uploads
Instagram and Facebook rupload and the Upload-Post multipart upload stream local files larger than 8 MiB (`ReadableStream` body, `duplex: "half"`, `Content-Length`/`file_size` from the file size, 1 MiB chunks), so memory stays flat for multi-hundred-MB renders (tested with a 300 MB sparse file). Smaller files go as one buffer. **Streaming request bodies were not verified against the live Meta or Upload-Post endpoints** (only against Node fetch on loopback and mock fetch); set `config.extra.uploadMode = "buffer"` (env `KLIPZ_UPLOAD_MODE=buffer` in the KLIPZ app) to restore the old read-into-memory behaviour.

## Doc re-verification (2026-11-11)
See code comments for URLs. Corrected: Graph default v27.0 (docs examples), YouTube videos.insert quota. Confirmed: TikTok endpoints (creator_info/query, video/init, status/fetch; unaudited = private only, no numeric limits published), Instagram Reels 3 s-15 min / 300 MB / rupload.facebook.com/ig-api-upload/{ver}/{container}, Facebook Reels video_reels start/finish + rupload video-upload (3-90 s, 540x960, 24-60 fps, 30 posts/24 h), X v2 media upload initialize/append/finalize/status, LinkedIn Videos API + `Linkedin-Version: YYYYMM` (202511 sunsets 2026-11-16; default here 202610), Ayrshare POST /api/post. Not verifiable from official docs: YouTube Shorts max 3 min (secondary sources only), X paid-tier requirement for media (docs silent; secondary sources say free tier ended Feb 2026 for pay-per-use), Upload-Post form field names and status path, Ayrshare analytics path.

## Verification notes
Endpoint paths follow the official docs as of writing (YouTube resumable upload, TikTok Content Posting API v2, Meta Reels rupload hosts, X v2 media upload, LinkedIn Videos API). Doc URLs are in code comments. Not verified live: no real credentials were used; all behaviour is tested against scripted mock fetch. Graph API version defaults to `DEFAULT_GRAPH_VERSION`; LinkedIn version header to `DEFAULT_LINKEDIN_VERSION`. Both may need bumping as platforms sunset versions.

## Tests
`npx vitest run packages/publishers` and `npx tsc --noEmit -p packages/publishers/tsconfig.json` from the repo root.
