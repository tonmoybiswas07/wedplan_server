import { Router } from "express";
import type { Collection, Document } from "mongodb";
import { db } from "./db.js";
import { authenticateJwt, requireRole } from "./auth-middleware.js";
import { adminUserCounts } from "./admin-users.js";
import { readBookingCounts } from "./bookings.js";
import { publishedServiceFilter } from "./published-services.js";
import { readVendorPlan } from "./subscriptions.js";
import { payments } from "./billing-store.js";
import { services } from "./services.js";

export const dashboardStats = Router();

const activityZone = "Asia/Dhaka";
const monthKey = new Intl.DateTimeFormat("en-CA", { timeZone: activityZone, year: "numeric", month: "2-digit" });

function activityMonths(now = new Date()) {
  const [year, month] = monthKey.format(now).split("-").map(Number);
  return Array.from({ length: 6 }, (_, index) =>
    new Date(Date.UTC(year, month - 6 + index, 1)).toISOString().slice(0, 7),
  );
}

async function monthlyCounts<T extends Document>(collection: Collection<T>, months: string[], scope = {}) {
  const counts = await collection.aggregate<{ _id: string; count: number }>([
    { $match: { ...scope, createdAt: { $gte: new Date(months[0] + "-01T00:00:00+06:00"), $lte: new Date() } } },
    { $group: { _id: { $dateToString: { date: "$createdAt", format: "%Y-%m", timezone: activityZone } }, count: { $sum: 1 } } },
  ]).toArray();
  return new Map(counts.map(({ _id, count }) => [_id, count]));
}

async function recentBookings(scope: { customerId: string } | { vendorId: string }) {
  return db.collection("bookings").aggregate([
    { $match: scope },
    { $sort: { createdAt: -1, _id: -1 } },
    { $limit: 4 },
    { $lookup: { from: "services", localField: "serviceId", foreignField: "_id", as: "listing" } },
    { $project: { _id: 0, id: { $toString: "$_id" }, date: "$createdAt", status: 1,
      title: { $ifNull: ["$serviceSnapshot.title", { $first: "$listing.title" }, "Service no longer listed"] } } },
  ]).toArray();
}

dashboardStats.get("/", authenticateJwt, requireRole("customer", "vendor", "admin"), async (_req, res) => {
  const { id, role } = res.locals.user!;
  try {
    if (role === "customer") {
      const [stats, recent] = await Promise.all([readBookingCounts(role, id), recentBookings({ customerId: id })]);
      res.json({ stats, recent });
      return;
    }
    const months = activityMonths();
    const bookingsCollection = db.collection("bookings");
    if (role === "vendor") {
      const [totalServices, activeServices, bookings, plan, monthly, recent] = await Promise.all([
        services.countDocuments({ vendorId: id }),
        services.countDocuments({ ...publishedServiceFilter, vendorId: id }),
        readBookingCounts(role, id),
        readVendorPlan(id),
        monthlyCounts(bookingsCollection, months, { vendorId: id }),
        recentBookings({ vendorId: id }),
      ]);
      res.json({ stats: { totalServices, activeServices, pendingRequests: bookings.pending, acceptedBookings: bookings.accepted, plan },
        activity: months.map((month) => ({ month, bookings: monthly.get(month) ?? 0 })), recent });
      return;
    }

    const [users, totalServices, pendingServices, transactions, userGrowth, serviceGrowth, bookingGrowth, recent] = await Promise.all([
      adminUserCounts(),
      services.countDocuments(),
      services.countDocuments({ status: "pending" }),
      payments.countDocuments(),
      monthlyCounts(db.collection("user"), months),
      monthlyCounts(services, months),
      monthlyCounts(bookingsCollection, months),
      services.find({}, { projection: { title: 1, status: 1, createdAt: 1 } }).sort({ createdAt: -1, _id: -1 }).limit(4).toArray(),
    ]);
    res.json({ stats: { ...users, totalServices, pendingServices, transactions },
      activity: months.map((month) => ({ month, users: userGrowth.get(month) ?? 0,
        services: serviceGrowth.get(month) ?? 0, bookings: bookingGrowth.get(month) ?? 0 })),
      recent: recent.map(({ _id, title, status, createdAt }) => ({ id: _id.toString(), title, status, date: createdAt })),
    });
  } catch {
    res.status(503).json({ message: "Dashboard statistics are temporarily unavailable." });
  }
});
