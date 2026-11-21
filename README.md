# WedPlan — Wedding Planning Platform API

The WedPlan API powers service discovery, bookings, user management, and vendor subscriptions. It enforces role permissions and stores application data in MongoDB.

## Important Features

- Browse wedding services by name, category, and location, with price sorting.
- Customers can request bookings, track their status, and cancel pending requests.
- Vendors can manage listings, upload photos, and accept or reject booking requests.
- Admins can moderate listings, manage users, and view transactions.
- Vendors can upgrade through Stripe Checkout in Test Mode. Verified webhook events activate Premium access.

## Technology Stack

- Frontend: Next.js, TypeScript, Tailwind CSS, shadcn/ui, and Motion
- Backend: Express, TypeScript, and MongoDB
- Integrations: Better Auth, Stripe Checkout and webhooks, and ImgBB

## Installation

Install Node.js and npm, then clone both repositories into sibling directories. Use the repository URLs listed below once available.

```bash
git clone https://github.com/tonmoybiswas07/wedplan_server wedplan-server
git clone https://github.com/tonmoybiswas07/wedplan_client wedplan-client
```

Use each repository's environment example to configure local variables. Set the MongoDB connection and auth configuration on the server. Set the frontend API base URL to the local backend address. Configure Google OAuth, ImgBB, or Stripe test credentials when testing those integrations.

## Run Locally

Start the server in one terminal.

```bash
cd wedplan-server
npm install
npm run dev
```

From the parent directory, start the client in another terminal.

```bash
cd wedplan-client
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The default API address is [http://localhost:8000](http://localhost:8000). If either port changes, update the corresponding URLs in your local environment configuration.

## Admin and Billing Setup

Create a regular account, then run the following command from the server directory with the registered email.

```bash
npm run promote-admin -- admin@example.com
```

For Stripe Test Mode, configure `STRIPE_SECRET_KEY`, `STRIPE_PREMIUM_PRICE_ID`, and `STRIPE_WEBHOOK_SECRET` in the server's local environment. Forward test events to the webhook route registered by the Express app and use the signing secret from the listener. After a test purchase, check the vendor's subscription and the Admin Transactions page.

## Project Links

| Resource | Link |
| --- | --- |
| Live website | Pending verified deployment URL |
| Client repository | Pending Git remote URL |
| Server repository | Pending Git remote URL |
