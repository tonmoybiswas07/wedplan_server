# WedPlan API

Set the variables from `.env.example` in the server's local `.env`. Keep secrets server-side. Set the client's `API_BASE_URL` to the Express URL.

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

Use the signing secret printed by that listener, then restart Express. Create Checkout from the Vendor dashboard and use Stripe's test payment credentials. A signed webhook reconciles the subscription and stores one transaction per invoice. Cancelling at period end keeps paid access through that period. Failed or expired subscriptions use the Free activation limit on future activation requests. Subscription changes and service availability use the existing MongoDB transaction-capable deployment.
