# WedPlan API

WedPlan is a wedding planning marketplace. This API handles the public catalogue, customer bookings, vendor listings and subscriptions, and Admin moderation and transaction reporting.

## Technology

Express, TypeScript, MongoDB, Better Auth with JWT/JWKS, ImgBB, and Stripe Checkout. The [Next.js client](https://github.com/tonmoybiswas07/wedplan_client) uses Tailwind CSS, shadcn/ui, and Motion.

## Run locally

Run `npm ci`, copy `.env.example` to `.env`, and set the variables below. Start Express with `npm run dev` and test `GET /api/health`. Use `npm run build` and `npm start` for a production-mode check. Configure the client's `API_BASE_URL` to use this Express server.

| Variable | Purpose |
| --- | --- |
| `PORT` | Express port, defaults to `8000` |
| `CLIENT_URL` | Browser-facing Next.js origin, defaults to `http://localhost:3000` |
| `BETTER_AUTH_URL` | Express origin used by Better Auth and JWT verification |
| `BETTER_AUTH_SECRET` | Private random secret of at least 32 characters |
| `MONGODB_URI` | Private MongoDB connection string for a transaction-capable deployment |
| `MONGODB_DB` | Database name, defaults to `WedPlanDB` |
| `IMGBB_API_KEY` | Private ImgBB key for file uploads |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth Web application credentials |
| `STRIPE_SECRET_KEY`, `STRIPE_PREMIUM_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | Stripe Test Mode billing and webhook configuration |

Keep real values in the server environment and keep `.env` out of version control. To provision an evaluator Admin, register a dedicated account and run `npm run promote-admin -- evaluator@example.com`. Share its credentials privately through the submission form.

- [Client repository](https://github.com/tonmoybiswas07/wedplan_client)
- [Server repository](https://github.com/tonmoybiswas07/wedplan_server)
- Live website link pending deployment and verification.

For deployment, build TypeScript and run `npm start` on the Express host. Point `CLIENT_URL` and `BETTER_AUTH_URL` at the exact deployed HTTPS origins and register the deployed Google callback and Stripe webhook URLs. Verify sign-in, role access after refresh, uploads, and the test payment flow on the deployed site.

## Google sign-in

Create a Google OAuth **Web application** client and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the Express environment. Set `CLIENT_URL` to the browser-facing Next.js origin and `BETTER_AUTH_URL` to the Express origin. On Google, register exactly `<CLIENT_URL>/api/auth/callback/google` as an authorized redirect URI. With the example configuration, use `http://localhost:3000/api/auth/callback/google`.

Use the same browser hostname throughout the flow. Next.js forwards the OAuth callback to Express and relays the Better Auth session cookie. New Google users choose Customer or Vendor before accessing protected features. Existing accounts retain their saved role. If a password account’s local email is unverified, sign in with the password first and use **Link Google account** in Profile Settings. Better Auth keeps its default email-verification safeguards for implicit linking.

Profile and service file uploads use `IMGBB_API_KEY`.

## Stripe Premium (Test Mode)

Set these server-side variables in `.env`:

| Variable | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe Test Mode secret key (`sk_test_…` or a restricted test key with the required permissions) |
| `STRIPE_PREMIUM_PRICE_ID` | The `price_…` ID of an active, positive-priced recurring Premium price in the same test account |
| `STRIPE_WEBHOOK_SECRET` | The `whsec_…` signing secret for the endpoint that delivers test events |

Set `CLIENT_URL` to the Next.js browser origin. The Checkout return pages live at `/dashboard/vendor/subscription/success` and `/dashboard/vendor/subscription/cancel`. Neither page changes billing state.

Configure the Stripe **snapshot events** destination at `<EXPRESS_ORIGIN>/api/stripe/webhook`. For local forwarding, run:

```sh
stripe listen --events checkout.session.completed,invoice.paid,invoice.payment_failed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.subscription.paused,customer.subscription.resumed --forward-to localhost:8000/api/stripe/webhook
```

Use the signing secret printed by that listener, then restart Express. Create Checkout from the Vendor dashboard and use Stripe's test payment credentials. A signed webhook reconciles the subscription and stores one transaction per invoice. Cancelling at period end keeps paid access through that period. Failed, cancelled, or expired subscriptions return to the Free limit. WedPlan retains up to three active listings in creation order and deactivates the rest. Express reconciles expired subscriptions on startup and every minute. Subscription changes and service availability use the existing MongoDB transaction-capable deployment.
