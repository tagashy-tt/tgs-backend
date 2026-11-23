# TAY'S STUDIO backend starter

Node.js + Express backend starter for Railway, Supabase Auth/Database, and PayPal.

## Current scope
- Health endpoint
- Public plan catalogue
- Supabase Auth token validation for protected endpoints
- Read current account entitlements
- Create PayPal subscription approval links (monthly/yearly PayPal plan IDs)
- Create/capture a lifetime PayPal order using a server-side price
- PayPal webhook signature verification scaffold
- Torrent policy endpoint: Free 10 MiB per download, Premium 100 MiB per download by default
- Processing methods and uploads are always reported as free
- In-app anime access is Premium-only

## Important: not production-ready yet
This is a scaffold, not a complete payment service. Before accepting real money:
1. Configure and test sandbox credentials.
2. Create PayPal subscription products/plans in PayPal Developer Dashboard and set their IDs.
3. Implement and test subscription-to-user mapping and every subscription webhook event.
4. Add webhook idempotency using `paypal_events` (the table is created but event deduplication is not wired yet).
5. Verify refund, chargeback, cancellation, renewal, failed-payment and expiry behavior.
6. Add rate limiting, request logging without secrets, monitoring, database backups and tests.
7. Set a real APP_BASE_URL and safe CORS origins.
8. Confirm PayPal merchant eligibility and the current PayPal terms for your country/business.
9. Implement authentication in the APK using Supabase Auth. Protected API calls require `Authorization: Bearer <Supabase access token>`.
10. The torrent endpoint only returns policy. It does not download torrents or enforce byte counts. Enforcement must happen in the downloader/worker.
11. Anime playback must use sources you are authorized to distribute or access; this backend does not scrape Nyaa.si or provide copyrighted episode files.

## Local development
1. Install Node.js 20+.
2. Copy `.env.example` to `.env` and fill in values.
3. Run `npm install`.
4. Run `npm start`.

## Railway
- Push this folder to a private GitHub repository.
- Create a Railway project and deploy from that repository.
- Set all environment variables in Railway Variables. Do not commit `.env`.
- Add a Supabase project and run `sql/schema.sql` in the SQL editor.
- Set the PayPal webhook URL to `https://YOUR-RAILWAY-DOMAIN/api/v1/paypal/webhook`.
- Subscribe to relevant PayPal events, at minimum capture completion and subscription lifecycle/payment events.
- Use Sandbox until all end-to-end tests pass.

## Routes
- `GET /health`
- `GET /api/v1/plans`
- `GET /api/v1/me/entitlements` (auth required)
- `POST /api/v1/paypal/subscription` (auth required; body `{ "plan": "monthly" | "yearly" }`)
- `POST /api/v1/paypal/lifetime/order` (auth required)
- `POST /api/v1/paypal/lifetime/capture` (auth required; body `{ "orderId": "..." }`)
- `POST /api/v1/paypal/webhook`
- `GET /api/v1/torrent/policy` (auth required)

## Environment variables
See `.env.example`. For lifetime purchases set `PAYPAL_LIFETIME_PRICE_USD` to the chosen amount, such as `39.99`. Price is only an example; choose the final price before launch.


## Owner account and subscription time remaining
- Set `OWNER_EMAIL` in Railway to the exact, verified email address of the owner's Supabase Auth account.
- The owner is identified on the server only; never accept a client-supplied `owner` flag or role.
- Owner gets all current Premium features without payment or expiry. Processing methods and uploads remain free for everyone.
- `GET /api/v1/me/entitlements` returns `role`, `plan`, `expiresAt`, and `daysRemaining` for customer accounts. `daysRemaining: null` means lifetime access or owner access; a value of `0` means no active subscription.
- The UI should display e.g. “Premium · quedan 12 días”, “Premium de por vida” or “Propietario · acceso completo”.
- Important: subscription webhook-to-user mapping and lifecycle event handling still need completion and tests before production. Do not enable live payments yet.


## Diagnostics (v0.3.1)

- `GET /api/v1/admin/paypal-check` (owner only, Bearer token): reports whether the
  PayPal credentials work and whether `PAYPAL_PLAN_MONTHLY_ID` / `PAYPAL_PLAN_YEARLY_ID`
  exist and are ACTIVE in the configured `PAYPAL_MODE`. No secrets are returned.
- Subscription errors now return a `code` (`plan_not_configured`, `plan_not_found`,
  `plan_inactive`, `paypal_not_authorized`, `paypal_credentials`, `paypal_unreachable`).
  `plan_not_found` almost always means the plan ID belongs to the other mode
  (sandbox vs live).
- Owner: recognised from `OWNER_EMAIL` without needing `email_verified_at`.
- Weekly limits: `GET /api/v1/me/usage`, `POST /api/v1/usage/consume|refund`.


## 0.4.0 — trial, anti-abuse, AI subtitles
- **7-day trial per device.** The app calls `POST /api/v1/device/hello` on first launch (this starts the clock) and sends `X-Device-Id` on every request.
  When an account signs in on that device it receives a normal `premium` row with `source = 'trial'` ending on the device's date.
  The entitlements answer reports `plan: "trial"` and a `trial` object `{active, endsAt, daysRemaining}`.
- **Rules:** one trial per device (a 2nd account shares the same end date, a 3rd gets none), at most `TRIAL_MAX_DEVICES_PER_IP` new devices per IP per day,
  banned devices / tampered builds (`INTEGRITY_ENFORCE=true`) / emulators (`TRIAL_BLOCK_EMULATORS=true`) get no trial. Paid, gifted and lifetime rows are never touched.
- **Anti-abuse:** per-IP rate limits (API, register, login, hello, subtitles), `abuse_events` log, `GET /api/v1/admin/abuse` and `POST /api/v1/admin/device/ban` (owner only).
  The tables (`device_trials`, `device_accounts`, `abuse_events`, `subtitle_jobs`) are created on first use; no SQL to run.
- **AI subtitles:** `POST /api/v1/subtitles?seconds=N&lang=es` with the audio bytes as body (Premium or active trial). Needs `STT_API_KEY`.
- **Tests:** `npm test` needs a PostgreSQL (`TEST_DATABASE_URL`); it wipes that database.
- Set `TRUST_PROXY=true` and `DEVICE_PEPPER` on Railway.

## 0.5.0 — claimable trial, paid features, subtitle quota
- `POST /api/v1/trial/claim` (auth): claims the 7-day trial. One claim per device and per account, forever (`device_trials`, `trial_claims`). Reasons the client may see: `device_used`, `account_used`, `has_premium_row`, `no_device`, `not_available` (anything that would help an abuser is returned as `not_available`). Rate limit: `TRIAL_CLAIMS_PER_HOUR` (default low; tests use 100). The device id is a hashed ANDROID_ID with a pepper; a factory reset can change it.
- Entitlements now report `trial` and `claimable`; the free plan no longer gets weekly uses: `FREE_WEEKLY_TOPAZ/CHECK/DOWNLOAD/DEADFRAMES` default to `0` (set a number to give free uses again). Process and upload patches stay free.
- Subtitles: `SUBS_MAX_SECONDS` (default 600 per file) and `SUBS_MONTHLY_SECONDS` (default 3600 per month); `GET /api/v1/subtitles/quota`; error `quota_reached`.
- Migration is automatic on start (new tables, `ends_at` nullable). Needs Postgres; run `node test/run.mjs` with `TEST_DATABASE_URL`.

## 0.5.1 — subtitle engines
- `STT_PROVIDERS` (order) + `STT_<ID>_URL/KEY/MODEL` for `whispercpp`, `fasterwhisper`, `openai`, `groq`; the old `STT_API_KEY` still works. `POST /api/v1/subtitles?engine=<id>` tries that engine first and falls back to the rest; `GET /api/v1/subtitles/quota` lists the engines that are on (`engines`).
- The projects sensevoice-subtitle-generator, Transcribix, subtitle-generator (asub), auto-subtitles and transcribe are local apps, not hosted APIs: run their engine as a server (whisper.cpp `whisper-server`, a faster-whisper OpenAI-compatible server) and point the URL at it. SenseVoice has no standard server protocol, so it is not wired.
- Without any engine the app shows "service not enabled" (503 `stt_not_configured`).


## 0.5.3 — Dead Frame Remover analysis on the server
- `POST /api/v1/deadframes/analyze?sens=0..2&minMs=300` (Bearer token, Premium or active trial). Body = the video bytes (max `DEADFRAMES_MAX_MB`, default 150). Runs ffmpeg `freezedetect` and answers `{cuts:[{startMs,endMs}], deadFrames, totalFrames, removedMs, durationMs, fps}`; the phone cuts the video.
- The Dockerfile now installs `ffmpeg` (Alpine package, includes ffprobe). Redeploy the image, not just the code.
- Env: `DEADFRAMES_MAX_MB`, `DEADFRAMES_PER_MINUTE` (default 4 per IP), `DEADFRAMES_CONCURRENCY` (default 2 at once).
- AI subtitles need at least one speech-to-text provider configured (see `.env.example`: Groq has a free tier). Without one the app shows "subtitles not enabled on the server".

## 0.5.2 — server-authoritative account and usage enforcement

- Keep the 7-day Premium trial as a **manual claim** (`POST /api/v1/trial/claim`). Registration/login never starts the clock. `TRIAL_DAYS` defaults to 7.
- The trial is limited to one claim per account and one claim per stable device ID. The Android app sends the SHA-256 of Android `ANDROID_ID` (plus app namespace); the backend hashes it again with `DEVICE_PEPPER`. Reinstalling the app does not normally change Android ID. A factory reset, device replacement, or a modified client can still change/spoof identifiers; this is abuse resistance, not unbreakable hardware attestation.
- Keep `DEVICE_PEPPER` stable across deployments. Changing it makes existing device hashes appear new and weakens device-level trial history.
- `TRIAL_MAX_DEVICES_PER_IP` defaults to 8 per 24 hours. Configure `TRIAL_BLOCK_EMULATORS` and `INTEGRITY_ENFORCE` only after testing legitimate-device false positives.
- Weekly usage counters live in PostgreSQL and are keyed by account, feature and week. The Android app no longer falls back to a local counter to authorize Topaz/Check/Download. These actions require sign-in and a successful live backend check; if Railway is unavailable, they fail closed instead of resetting limits.
- `FREE_WEEKLY_TOPAZ`, `FREE_WEEKLY_CHECK`, `FREE_WEEKLY_DOWNLOAD`, and `FREE_WEEKLY_DEADFRAMES` remain server-side controls (default 0). Premium/trial/owner accounts are unlimited for these counters. Do not change the PayPal plan IDs or prices as part of this release.
- Existing subscription, Lifetime and payment webhook logic is intentionally unchanged.

### Deployment

1. Deploy `TGS BACKEND 0.5.2` to the existing Railway service and retain the same PostgreSQL volume/database.
2. Preserve the existing `DEVICE_PEPPER`, `APP_BASE_URL`, PayPal credentials, plan IDs and webhook configuration. Do not rotate secrets during this update.
3. Confirm `/health` reports version `0.5.2`, then test registration, manual trial claim, reinstall/login, repeated claim refusal, usage snapshots, and paid/Lifetime entitlement checks.
4. Build Android `1.1.1` only after the backend is deployed. The app uses the existing Railway base URL.

The app-side usage checks are a deterrent against ordinary reinstall/reset bypasses, not a substitute for enforcing paid features on the server that actually performs a cloud job. Local-only processing cannot be made fully tamper-proof by a remote quota check alone.


## 0.5.5 — beta gift fix, safe trial migration, diagnostics

- **Beta emails (`BETA_PREMIUM_EMAILS`)**: the list is now parsed with a regex, so `"a@x.com","b@x.com"`, one email per line, `<a@x.com>`, `;` or spaces all work (before, inner quotes made emails never match).
  The gift is also given to accounts whose old premium row is **expired/inactive** or is an **active 7-day trial** (0.5.3 skipped any account with any premium row, which is why newly added emails "did nothing").
  Active paid / lifetime / manual Premium is never replaced; an earlier beta gift is not repeated unless `BETA_PREMIUM_REGRANT=true`.
  After changing the variable in Railway, redeploy/restart so the new value is loaded.
- **Trial 500**: the trial tables migration now runs in one transaction under a Postgres advisory lock (two containers starting during a deploy used to collide with `duplicate key ... pg_class_relname_nsp_index`), and each step is named in the logs.
- **`GET /api/v1/admin/diagnostics`** (owner Bearer token): shows if the trial schema migrates (and the failing step), and for every email in `BETA_PREMIUM_EMAILS` whether the account exists and why it would or would not be gifted.
- 500 errors now log the route (`Backend error on POST /api/v1/trial/claim: [step: ...] code message`) so Railway logs show the exact cause.
