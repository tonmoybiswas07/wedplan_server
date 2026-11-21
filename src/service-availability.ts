import type { ObjectId } from "mongodb";
import { MongoServerError } from "mongodb";
import { client, db } from "./db.js";
import { services } from "./services.js";

const FREE_ACTIVE_SERVICES = 3;
const locks = db.collection<{ _id: string; version: number }>("serviceAvailabilityLocks");

// Billing can persist one current subscription per vendor, keyed by the Better Auth user ID.
const subscriptions = db.collection<{
  _id: string;
  plan: "free" | "premium";
  status: "active" | "inactive" | "canceled";
  currentPeriodEnd: Date;
}>("subscriptions");

export async function changeAvailability(vendorId: string, id: ObjectId, isActive: boolean) {
  const filter = { _id: id, vendorId };
  const update = { $set: { isActive, updatedAt: new Date() }, $unset: { active: "" as const } };

  if (!isActive) {
    const service = await services.findOneAndUpdate(filter, update, { returnDocument: "after" });
    return service ? { service } : { error: "missing" as const };
  }

  try {
    await locks.updateOne({ _id: vendorId }, { $setOnInsert: { version: 0 } }, { upsert: true });
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
  }

  return client.withSession((session) => session.withTransaction(async () => {
    // Concurrent activations for the same owner conflict on this write and retry with a fresh snapshot.
    await locks.updateOne({ _id: vendorId }, { $inc: { version: 1 } }, { session });
    const service = await services.findOne(filter, { session });
    if (!service) return { error: "missing" as const };
    if (service.status !== "approved") return { error: "unapproved" as const };
    if (service.isActive ?? service.active) return { service };

    const premium = await subscriptions.findOne({
      _id: vendorId, plan: "premium", status: "active", currentPeriodEnd: { $gt: new Date() },
    }, { session, projection: { _id: 1 } });

    if (!premium) {
      const activeCount = await services.countDocuments({
        vendorId,
        $or: [{ isActive: true }, { isActive: { $exists: false }, active: true }],
      }, { session, limit: FREE_ACTIVE_SERVICES });
      if (activeCount >= FREE_ACTIVE_SERVICES) return { error: "limit" as const };
    }

    const updated = await services.findOneAndUpdate(filter, update, { session, returnDocument: "after" });
    return updated ? { service: updated } : { error: "missing" as const };
  }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }));
}
