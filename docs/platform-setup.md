# Platform setup (personal use)

KLIPZ posts with YOUR OWN developer apps. Nothing here has been exercised against a real platform (see "Known limitations" in the README). Platform rules change often: where this page says "as of November 2026" it reflects the platform docs read on 2026-11-11 by the publisher adapter authors, plus secondary sources where noted. Re-check the linked docs before relying on a number.

Common to all platforms:

- Open the app, go to **Accounts**. It shows, per platform, whether it is configured, which env variables are missing, and the exact **redirect URI** to register.
- Default redirect URI: `http://localhost:3000/api/oauth/<provider>/callback`, where `<provider>` is `youtube`, `tiktok`, `instagram`, `facebook`, `x` or `linkedin`. If you start KLIPZ on another port (`KLIPZ_PORT`) the launcher sets `APP_URL` to match; if you use an HTTPS tunnel, set `APP_URL=https://your-tunnel.example` and the URIs become `${APP_URL}/api/oauth/<provider>/callback`. Register exactly what the Accounts page shows (no trailing slash).
- Put keys in `apps/web/.env.local` (or the repo-root `.env.local`; the web app reads both and `apps/web/.env.local` wins), then restart KLIPZ.
- Tokens are encrypted at rest (AES-256-GCM) with a key in `<data dir>/secret.key` (or `TOKEN_ENCRYPTION_KEY`). Back that file up with the database, or you must reconnect every account.
- No tokens ever go anywhere except the platform they belong to.

Always try the flow first in **sandbox mode** (`KLIPZ_PUBLISH_MOCK=1`, see the end of this page) so you know the app side works before you spend time in developer consoles.

---

## YouTube (Shorts)

1. Google Cloud Console: create a project and enable **YouTube Data API v3** (also **YouTube Analytics API** if you want views/likes on the Analytics page).
2. OAuth consent screen: user type **External**, publishing status **Testing**. Add your own Google account under "Test users".
3. Credentials, "Create credentials", **OAuth client ID**, type **Web application**. Authorised redirect URI: the YouTube one from the Accounts page.
4. Paste the client id and secret into `apps/web/.env.local`:
   `YOUTUBE_CLIENT_ID=...` and `YOUTUBE_CLIENT_SECRET=...`
5. Restart KLIPZ, Accounts, Connect YouTube.

Scopes requested: `youtube.upload`, `youtube.readonly`, `yt-analytics.readonly` (offline access, consent prompt each time).

Before review:

- In Testing mode refresh tokens expire after 7 days: you will have to reconnect weekly (the account shows "needs reconnect").
- Videos uploaded through an API project that has not passed the **YouTube API Services compliance audit** are locked to **private**. You can still open them in YouTube Studio and make them public by hand.
- Quota: per the adapter authors' reading of the quota docs (2026-11-11), `videos.insert` has its own bucket (1 per call, 100 per day by default) separate from the 10,000 units/day for other calls. Older material says an upload costs 1,600 units of the 10,000 daily quota; the docs changed. Quota errors are reported as `quota_exceeded` and retried.
- "Shorts" is decided by YouTube (vertical, short enough, `#Shorts`); the maximum Shorts length (3 minutes) comes from secondary sources only.

---

## TikTok

1. developers.tiktok.com: create an app. Add the products **Login Kit** and **Content Posting API** (turn on **Direct Post**). Add yourself as a Target User in the Sandbox.
2. Scopes: `user.info.basic`, `video.publish`, `video.list`.
3. Register the redirect URI. **TikTok web login requires an HTTPS redirect on a domain you registered**; `http://localhost` is rejected. Two ways:
   - HTTPS tunnel (cloudflared, ngrok, ...) pointing at 127.0.0.1:3000, then set `APP_URL=https://your-tunnel.example` and register `https://your-tunnel.example/api/oauth/tiktok/callback`. The tunnel exposes your local app to the internet while it is up; KLIPZ has no login, so keep the tunnel closed except while connecting, or protect it (the app only accepts requests whose Host matches `APP_URL`/loopback, and mutating calls must be same-origin, but this is not a substitute for access control).
   - Or route TikTok through an aggregator (`AGGREGATOR_PROVIDERS=tiktok`, see below).
4. `apps/web/.env.local`: `TIKTOK_CLIENT_ID=<client key>` and `TIKTOK_CLIENT_SECRET=...`

Before audit: an **unaudited** client can only post **private (SELF_ONLY)** videos and has a small daily limit. KLIPZ's composer implements the Direct Post UX TikTok requires for the audit:

- shows the connected creator's nickname and the privacy options TikTok returns for that creator,
- privacy has **no default**: you must choose,
- comments / duet / stitch toggles (greyed out if the creator disabled them in TikTok),
- commercial-content disclosure ("Your brand" / "Branded content"; branded content cannot be private),
- the TikTok consent line (Music Usage Confirmation, or Branded Content Policy as well) and an explicit tick before posting.

The app also warns (`unaudited_app_forced_private`, non-blocking) when you pick a non-private level on an unaudited app. Set `TIKTOK_AUDITED=true` once TikTok has audited your app; the warning then disappears.

Upload is chunked file upload by default. `TIKTOK_SOURCE=pull` switches to PULL_FROM_URL, which needs a verified URL prefix and a public URL for the file, so it is not useful for a local app.

---

## Instagram Reels

1. developers.facebook.com: create an app of type **Business**; add **Facebook Login for Business** (or Facebook Login).
2. The Instagram account must be **Business or Creator** (Professional) and **linked to a Facebook Page**.
3. Valid OAuth redirect URIs: add both the Instagram and the Facebook callback (they share the Meta app).
4. `apps/web/.env.local`: `META_APP_ID=...` and `META_APP_SECRET=...` (shared by Instagram and Facebook). If you use Facebook Login for Business with a configuration, set `META_CONFIG_ID` (the scopes are then taken from that configuration instead of the request).
5. Scopes requested: `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`, `business_management`.

Before review: an app in **Development mode** works for Instagram accounts and Pages where you (or another person) have a **role on the app** (admin, developer or tester). No App Review needed for that. Meta allows `http://localhost` redirects only in Development mode; once Live it needs HTTPS.

Limits (docs as of November 2026): Reels 3 s to 15 min, up to 300 MB; about 100 API-published posts per 24 h per account. KLIPZ streams files above 8 MiB to Meta's upload host in 1 MiB chunks. **That streaming upload was tested only against a local mock, not against Meta.** If uploads fail, the adapter can be forced to whole-file upload (set `KLIPZ_UPLOAD_MODE=buffer`).

`META_GRAPH_VERSION` overrides the Graph API version if the default is sunset.

---

## Facebook Page Reels

Same Meta app and same two env variables as Instagram. Scopes: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `read_insights`, `business_management`. You post to a **Page** you manage (not a personal profile); page tokens are stored per page. Development mode works for Pages where you have a role on the app. Reels: 3 to 90 s, at least 540x960, 24 to 60 fps, about 30 posts per 24 h (docs as of November 2026).

---

## X (Twitter)

1. developer.x.com: create a project and app. Enable **OAuth 2.0** with type **Web App / confidential client**; set the callback URL. `http://localhost` is accepted for development apps.
2. Scopes: `tweet.read tweet.write users.read media.write offline.access`.
3. `apps/web/.env.local`: `X_CLIENT_ID=...` and `X_CLIENT_SECRET=...` (the OAuth 2.0 client id and secret).

Cost: posting video needs a paid tier or pay-per-use credits. On an account without access the API answers 403, which KLIPZ shows as `tier_required` (retrying will not help). Whether media posting needs a paid tier is not stated in the official docs; the requirement comes from secondary sources, so check your current plan on developer.x.com. 429s honour `x-rate-limit-reset`. Text limit 280 weighted characters (AI captions for X are generated to fit, hashtags included). A 403 for duplicate text maps to `duplicate_content` (non-retryable); other 403s show the platform's own message.

---

## LinkedIn

1. linkedin.com/developers: create an app (it requires a LinkedIn Company Page to associate).
2. Products tab: request **Share on LinkedIn** (gives `w_member_social`, self-serve) and **Sign In with LinkedIn using OpenID Connect** (`openid profile`).
3. Auth tab: add the redirect URI. `http://localhost` is accepted for development.
4. `apps/web/.env.local`: `LINKEDIN_CLIENT_ID=...` and `LINKEDIN_CLIENT_SECRET=...`

KLIPZ posts to your **member profile**. Posting as an organization needs the Community Management API (`w_organization_social`), which requires LinkedIn review, and is not enabled by default (`LINKEDIN_EXTRA_SCOPES` can request more scopes if you have been approved). Analytics need `r_member_postAnalytics`/`r_member_social`, which are restricted: expect empty LinkedIn metrics. `LINKEDIN_VERSION` overrides the `Linkedin-Version` header (YYYYMM); LinkedIn sunsets old versions (202511 sunsets on 2026-11-16, the adapter default is 202610).

---

## App-review checklist

Only needed to post to **other people's** accounts or to make content public where the platform forces private until audit. For your own accounts, use the "before review" behaviour above.

- [ ] **TikTok**: submit the app for the Content Posting API audit with a demo video showing the Direct Post UX (creator info, privacy picker without default, interaction toggles, commercial-content disclosure, consent text). Until approved, all posts are private.
- [ ] **Meta**: complete **Business Verification**; submit **App Review** for `instagram_content_publish`, `pages_manage_posts`, `pages_read_engagement` (and `instagram_manage_insights`, `read_insights` for analytics) with a screencast and test credentials; switch the app to **Live**.
- [ ] **YouTube**: Google **OAuth app verification** (sensitive scope `youtube.upload`), then the **YouTube API Services compliance audit** to lift the forced-private restriction; request a quota extension if you outgrow the defaults (10,000 units/day general quota; `videos.insert` bucket per the quota docs).
- [ ] **X**: subscribe to a paid tier / enable pay-per-use credits to post media.
- [ ] **LinkedIn**: "Share on LinkedIn" is self-serve; Community Management API review for company pages and analytics.

---

## Aggregator route (fallback until approved)

An aggregator is a paid third-party service whose own apps are already approved by the platforms. You connect your social accounts inside the aggregator's dashboard, and KLIPZ sends the video to the aggregator's API. This is optional and costs money.

Supported: **Upload-Post** (`upload-post`) and **Ayrshare** (`ayrshare`). In `apps/web/.env.local`:

```
AGGREGATOR_KIND=upload-post
AGGREGATOR_API_KEY=your-key
AGGREGATOR_PROVIDERS=tiktok,instagram
```

- `AGGREGATOR_PROVIDERS` is a comma list of the platforms to route through the service; every other platform keeps using your own app. Allowed names: `youtube tiktok instagram facebook x linkedin`.
- Optional: `AGGREGATOR_PROFILE_KEY` (the aggregator's profile/user to post as), `AGGREGATOR_BASE_URL` (override the API host).
- On the Accounts page a routed platform shows a "via aggregator" badge and a plain **Connect** button (a same-origin POST that creates a local placeholder account); no OAuth happens in KLIPZ.
- Publishing, status polling and metrics for that platform are delegated to the aggregator; KLIPZ still runs its own validation (including the TikTok consent UX).
- Not verified: Upload-Post form field names and status path, and the Ayrshare analytics path, could not be confirmed from official docs. Streaming upload to Upload-Post was tested only against a mock. Treat the aggregator path as untested until you have posted one real clip.

---

## Sandbox mode (no platform app needed)

Set `KLIPZ_PUBLISH_MOCK=1` in `apps/web/.env.local` (or in the environment) and restart. Then:

- Accounts shows a banner and an **Add sandbox account** button per platform. These are fake accounts.
- The full pipeline runs: composer, validation (including per-platform limits and the TikTok consent UX), scheduling, retries, the Posts page and Analytics. Posts get made-up links and metrics. Nothing is sent anywhere.
- A scripted run of this mode is what `npm run e2e` uses.

Remove the variable and restart to go back to real publishing. Sandbox accounts are fake and do not carry over.
