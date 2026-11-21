import type { ClientSession } from "mongodb";
import { db } from "./db.js";

export type Subscription = {
  _id: string;
  plan: "free" | "premium";
  status: "active" | "inactive" | "canceled";
  currentPeriodEnd: Date;
  stripeSubscriptionId?: string;
  stripeCreatedAt?: number;
  stripeStatus?: string;
  cancelAtPeriodEnd?: boolean;
};

export const subscriptions = db.collection<Subscription>("subscriptions");

export function hasPremium(subscription: Subscription | null) {
  return subscription?.plan === "premium" && subscription.status === "active"
    && subscription.currentPeriodEnd > new Date();
}

export async function readVendorPlan(vendorId: string, session?: ClientSession) {
  return hasPremium(await subscriptions.findOne({ _id: vendorId }, { session })) ? "premium" : "free";
}
