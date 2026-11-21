import { randomUUID } from "node:crypto";
import { raw, Router } from "express";
import { MongoServerError } from "mongodb";
import { z } from "zod";
import { authenticateJwt, requireRole } from "./auth-middleware.js";
import { clientOrigin } from "./auth.js";
import { checkoutConfirmations, payments } from "./billing-store.js";
import { db } from "./db.js";
import { billingConfigured, priceId, processStripeEvent, stripe, stripeId, webhookSecret } from "./stripe-billing.js";
import { hasPremium, subscriptions } from "./subscriptions.js";

type CheckoutAttempt = {
  _id: string; attemptId: string; expiry: number; email: string; stripeCheckoutId?: string;
};
const attempts = db.collection<CheckoutAttempt>("stripeCheckoutAttempts");
const terminal = new Set(["canceled", "incomplete_expired"]);
const subscriptionPath = "/dashboard/vendor/subscription";
export const vendorBilling = Router();
vendorBilling.use(authenticateJwt, requireRole("vendor"));

let cachedPrice: { expires: number; data: { amount: number; currency: string; interval: string; intervalCount: number } } | undefined;
async function premiumPrice() {
  if (!stripe || !priceId) return null;
  if (cachedPrice && cachedPrice.expires > Date.now()) return cachedPrice.data;
  const price = await stripe.prices.retrieve(priceId);
  if (price.livemode || !price.active || !price.recurring || !price.unit_amount) return null;
  const data = { amount: price.unit_amount, currency: price.currency, interval: price.recurring.interval, intervalCount: price.recurring.interval_count };
  cachedPrice = { expires: Date.now() + 60_000, data };
  return data;
}

vendorBilling.get("/", async (req, res) => {
  try {
    const id = res.locals.user.id;
    const query = z.object({ session_id: z.string().regex(/^cs_test_[a-zA-Z0-9]+$/).max(180).optional() }).safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ message: "Invalid Checkout return." });
      return;
    }
    const checkoutId = query.data.session_id;
    const [subscription, checkout] = await Promise.all([
      subscriptions.findOne({ _id: id }),
      checkoutId ? checkoutConfirmations.findOne({ _id: checkoutId, vendorId: id }) : null,
    ]);
    const premium = hasPremium(subscription);
    const price = checkoutId || !billingConfigured ? null : await premiumPrice().catch(() => null);
    res.json({
      plan: premium ? "premium" : "free",
      billingAvailable: billingConfigured && Boolean(price),
      status: premium ? "active" : subscription && subscription.currentPeriodEnd <= new Date()
        && (subscription.status === "active" || subscription.stripeStatus === "active") ? "expired" : subscription?.status ?? "inactive",
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
      awaitingPayment: !premium && Boolean(subscription?.stripeStatus && ["past_due", "unpaid", "incomplete", "paused"].includes(subscription.stripeStatus)),
      checkoutConfirmed: !!checkout && premium && checkout.subscriptionId === subscription?.stripeSubscriptionId,
      price,
    });
  } catch {
    res.status(503).json({ message: "Subscription information is unavailable." });
  }
});

vendorBilling.post("/checkout", async (_req, res) => {
  const api = stripe;
  if (!api || !billingConfigured || !priceId) {
    res.status(503).json({ message: "Stripe Test Mode checkout is not configured." });
    return;
  }

  try {
    const { id, email } = res.locals.user;
    const subscription = await subscriptions.findOne({ _id: id });
    const now = Math.floor(Date.now() / 1000);
    let attempt = await attempts.findOne({ _id: id });
    let existingCheckout = attempt?.stripeCheckoutId ? await api.checkout.sessions.retrieve(attempt.stripeCheckoutId) : null;
    const previousSubscription = subscription?.stripeSubscriptionId ?? stripeId(existingCheckout?.subscription);
    if (previousSubscription && !terminal.has((await api.subscriptions.retrieve(previousSubscription)).status)) {
      res.status(409).json({ message: "You already have a Stripe subscription. Check its status before starting another." });
      return;
    }
    if (existingCheckout?.status === "open" && existingCheckout.url) {
      res.json({ url: existingCheckout.url });
      return;
    }

    if (!await premiumPrice()) {
      res.status(503).json({ message: "The configured Premium price is unavailable." });
      return;
    }
    const fresh = { attemptId: randomUUID(), expiry: now + 3600, email };
    if (attempt && (attempt.expiry <= now || existingCheckout?.status === "complete" || existingCheckout?.status === "expired")) {
      attempt = await attempts.findOneAndUpdate({ _id: id, attemptId: attempt.attemptId }, {
        $set: fresh, $unset: { stripeCheckoutId: "" },
      }, { returnDocument: "after" });
    }
    if (!attempt) {
      try {
        attempt = await attempts.findOneAndUpdate({ _id: id }, { $setOnInsert: fresh }, { upsert: true, returnDocument: "after" });
      } catch (error) {
        if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
        attempt = await attempts.findOne({ _id: id });
      }
    }
    if (!attempt) throw new Error("Unable to reserve checkout.");
    if (attempt.stripeCheckoutId) {
      existingCheckout = await api.checkout.sessions.retrieve(attempt.stripeCheckoutId);
      if (existingCheckout.status === "open" && existingCheckout.url) {
        res.json({ url: existingCheckout.url });
        return;
      }
      res.status(409).json({ message: "Your previous checkout is being processed. Try again shortly." });
      return;
    }
    const metadata = { wedplanVendorId: id, wedplanPriceId: priceId };
    const checkout = await api.checkout.sessions.create({
      mode: "subscription",
      customer_email: attempt.email, client_reference_id: id,
      line_items: [{ price: priceId, quantity: 1 }], metadata,
      subscription_data: { metadata },
      expires_at: attempt.expiry,
      success_url: `${clientOrigin}${subscriptionPath}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientOrigin}${subscriptionPath}/cancel`,
    }, { idempotencyKey: `wedplan-checkout-${attempt.attemptId}` });
    if (checkout.livemode || checkout.status !== "open" || !checkout.url) {
      res.status(409).json({ message: "This checkout is already being processed." });
      return;
    }
    await attempts.updateOne({ _id: id, attemptId: attempt.attemptId }, { $set: { stripeCheckoutId: checkout.id } });
    res.json({ url: checkout.url });
  } catch {
    res.status(503).json({ message: "Checkout could not be started. Try again shortly." });
  }
});

export const stripeWebhook = Router();
stripeWebhook.post("/", raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
  const api = stripe;
  if (!api || !webhookSecret?.startsWith("whsec_")) {
    res.status(503).json({ message: "Stripe webhook is not configured." });
    return;
  }
  const signature = req.get("stripe-signature");
  if (!signature || !Buffer.isBuffer(req.body)) {
    res.status(400).json({ message: "Invalid Stripe webhook signature." });
    return;
  }

  let event;
  try {
    event = api.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch {
    res.status(400).json({ message: "Invalid Stripe webhook signature." });
    return;
  }
  if (event.livemode !== false) {
    res.status(400).json({ message: "Only Test Mode events are accepted." });
    return;
  }

  try {
    await processStripeEvent(event, api);
    res.json({ received: true });
  } catch {
    res.status(503).json({ message: "The Stripe event could not be processed. Retry delivery." });
  }
});

export const adminTransactions = Router();
adminTransactions.use(authenticateJwt, requireRole("admin"));
const pageNumber = z.object({ page: z.string().regex(/^[1-9]\d{0,5}$/).default("1").transform(Number) });
const PAGE_SIZE = 20;

adminTransactions.get("/", async (req, res) => {
  const parsed = pageNumber.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: "Choose a valid page." });
    return;
  }
  try {
    const results = await payments.aggregate([
      { $sort: { date: -1, _id: -1 } },
      { $skip: (parsed.data.page - 1) * PAGE_SIZE },
      { $limit: PAGE_SIZE + 1 },
      {
        $lookup: {
          from: "user", let: { vendorId: { $convert: { input: "$vendorId", to: "objectId", onError: null, onNull: null } } },
          pipeline: [
            { $match: { $expr: { $eq: ["$_id", "$$vendorId"] } } },
            { $project: { _id: 0, name: 1, businessName: 1 } },
          ], as: "account",
        }
      },
      {
        $project: {
          _id: 0, id: "$_id", plan: 1, amount: 1, currency: 1, status: 1, date: 1,
          vendor: { $ifNull: [{ $first: "$account.name" }, { $first: "$account.businessName" }, "Vendor unavailable"] },
        }
      },
    ]).toArray();
    res.json({ transactions: results.slice(0, PAGE_SIZE), hasNext: results.length > PAGE_SIZE });
  } catch {
    res.status(503).json({ message: "Transactions are temporarily unavailable." });
  }
});
