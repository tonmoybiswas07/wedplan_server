import Stripe from "stripe";
import { ObjectId } from "mongodb";
import { client, db } from "./db.js";
import { billingEvents, checkoutConfirmations, payments } from "./billing-store.js";
import { enforceFreeAvailability, ensureVendorLock, lockVendor } from "./service-availability.js";
import { subscriptions } from "./subscriptions.js";

const key = process.env.STRIPE_SECRET_KEY?.trim();
export const priceId = process.env.STRIPE_PREMIUM_PRICE_ID?.trim();
export const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
export const stripe = key && /^(?:sk|rk)_test_/.test(key) ? new Stripe(key, {
  timeout: 8000, maxNetworkRetries: 0,
  httpClient: Stripe.createFetchHttpClient(),
}) : null;
export const billingConfigured = Boolean(stripe && priceId?.startsWith("price_") && webhookSecret?.startsWith("whsec_"));

export function stripeId(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : value?.id;
}

function subscriptionId(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed":
      return event.data.object.mode === "subscription" ? stripeId(event.data.object.subscription) : undefined;
    case "invoice.paid":
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice & { subscription?: string };
      return stripeId(invoice.parent?.subscription_details?.subscription ?? invoice.subscription);
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      return event.data.object.id;
  }
}

function managed(subscription: Stripe.Subscription) {
  const { wedplanVendorId, wedplanPriceId } = subscription.metadata;
  if (subscription.livemode || !/^[\da-f]{24}$/i.test(wedplanVendorId ?? "") || !wedplanPriceId) return null;
  const item = subscription.items.data.find(({ price }) => price.id === wedplanPriceId);
  return { vendorId: wedplanVendorId, item };
}

export async function processStripeEvent(event: Stripe.Event, api: Stripe) {
  const related = subscriptionId(event);
  if (!related || await billingEvents.findOne({ _id: event.id }, { projection: { _id: 1 } })) return;

  const discovered = managed(await api.subscriptions.retrieve(related));
  if (!discovered) return;
  const { vendorId } = discovered;
  const vendor = await db.collection("user").findOne({ _id: new ObjectId(vendorId), role: "vendor" }, { projection: { _id: 1 } });
  if (!vendor) return;
  await ensureVendorLock(vendorId);

  await client.withSession((session) => session.withTransaction(async () => {
    // Serialize reconciliation and vendor availability updates, then read Stripe's latest state.
    await lockVendor(vendorId, session);
    if (await billingEvents.findOne({ _id: event.id }, { session })) return;

    const subscription = await api.subscriptions.retrieve(related, { expand: ["latest_invoice"] });
    const source = managed(subscription);
    if (!source || source.vendorId !== vendorId) return;

    const latest = subscription.latest_invoice;
    const period = new Date((source.item?.current_period_end ?? 0) * 1000);
    if (!Number.isFinite(period.getTime())) throw new Error("Missing Stripe billing period.");
    const paid = typeof latest === "object" && latest?.status === "paid";
    const status = subscription.status === "canceled" || subscription.status === "incomplete_expired" ? "canceled"
      : subscription.status === "active" && paid && source.item && period > new Date() ? "active" : "inactive";

    const current = await subscriptions.findOne({ _id: vendorId }, { session });
    if (!current?.stripeSubscriptionId || current.stripeSubscriptionId === related
      || subscription.created > (current.stripeCreatedAt ?? 0)) {
      await subscriptions.updateOne({ _id: vendorId }, {
        $set: {
          plan: "premium", status, currentPeriodEnd: period, stripeSubscriptionId: related,
          stripeCreatedAt: subscription.created, stripeStatus: subscription.status,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
        }
      }, { session, upsert: true });
      if (status !== "active") await enforceFreeAvailability(vendorId, session);
    }

    if (event.type === "checkout.session.completed") {
      const checkout = event.data.object;
      if (!checkout.livemode && checkout.client_reference_id === vendorId && checkout.metadata?.wedplanVendorId === vendorId) {
        await checkoutConfirmations.updateOne({ _id: checkout.id }, {
          $setOnInsert: { vendorId, subscriptionId: related },
        }, { session, upsert: true });
        const checkoutInvoice = stripeId(checkout.invoice);
        if (checkoutInvoice) {
          await payments.updateOne({ _id: checkoutInvoice, vendorId }, { $set: { stripeSessionId: checkout.id } }, { session });
        }
      }
    }

    if (source.item && (event.type === "invoice.paid" || event.type === "invoice.payment_failed")) {
      const invoice = event.data.object;
      const existing = await payments.findOne({ _id: invoice.id }, { session });
      const settled = event.type === "invoice.paid";
      if (!existing || (settled && existing.status !== "paid")) {
        const timestamp = settled ? invoice.status_transitions?.paid_at ?? event.created : event.created;
        const checkout = invoice.billing_reason === "subscription_create"
          ? await checkoutConfirmations.findOne({ vendorId, subscriptionId: related }, { session }) : null;
        await payments.updateOne({ _id: invoice.id }, {
          $set: {
            vendorId, plan: "premium", amount: settled ? invoice.amount_paid : invoice.amount_due,
            currency: invoice.currency, status: settled ? "paid" : "failed", date: new Date(timestamp * 1000),
            stripeSubscriptionId: related, ...(checkout ? { stripeSessionId: checkout._id } : {}),
          },
          $setOnInsert: { createdAt: new Date(event.created * 1000) },
        }, { session, upsert: true });
      }
    }

    await billingEvents.insertOne({ _id: event.id, processedAt: new Date() }, { session });
  }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }));
}
