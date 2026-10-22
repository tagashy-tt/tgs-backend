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
