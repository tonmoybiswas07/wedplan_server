import { db } from "./db.js";

export const billingEvents = db.collection<{ _id: string; processedAt: Date }>("stripeEvents");
export const checkoutConfirmations = db.collection<{
  _id: string; vendorId: string; subscriptionId: string;
}>("stripeCheckoutConfirmations");
export const payments = db.collection<{
  _id: string;
  vendorId: string;
  plan: "premium";
  amount: number;
  currency: string;
  status: "paid" | "failed";
  date: Date;
  stripeSubscriptionId?: string;
  stripeSessionId?: string;
  createdAt?: Date;
}>("transactions");
