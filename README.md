# WedPlan API

Set the variables from `.env.example` in the server's local `.env`. Keep secrets server-side. Set the client's `API_BASE_URL` to the Express URL.

## Google sign-in

Create a Google OAuth **Web application** client and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the Express environment. Set `CLIENT_URL` to the browser-facing Next.js origin and `BETTER_AUTH_URL` to the Express origin. On Google, register exactly `<CLIENT_URL>/api/auth/callback/google` as an authorized redirect URI. With the example configuration, use `http://localhost:3000/api/auth/callback/google`.

Use the same browser hostname throughout the flow. Next.js forwards the OAuth callback to Express and relays the Better Auth session cookie. New Google users choose Customer or Vendor before accessing protected features. Existing accounts retain their saved role. If a password account’s local email is unverified, sign in with the password first and use **Link Google account** in Profile Settings. Better Auth keeps its default email-verification safeguards for implicit linking.

Profile and service file uploads use `IMGBB_API_KEY`.
