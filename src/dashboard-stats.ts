import { Router } from "express";
import { authenticateJwt, requireRole } from "./auth-middleware.js";
import { adminUserCounts } from "./admin-users.js";
import { readBookingCounts } from "./bookings.js";
import { publishedServiceFilter } from "./published-services.js";
import { readVendorPlan } from "./service-availability.js";
import { services } from "./services.js";

export const dashboardStats = Router();

dashboardStats.get("/", authenticateJwt, requireRole("customer", "vendor", "admin"), async (_req, res) => {
  const { id, role } = res.locals.user!;
  try {
    if (role === "customer") {
      res.json({ stats: await readBookingCounts(role, id) });
      return;
    }
    if (role === "vendor") {
      const [totalServices, activeServices, bookings, plan] = await Promise.all([
        services.countDocuments({ vendorId: id }),
        services.countDocuments({ ...publishedServiceFilter, vendorId: id }),
        readBookingCounts(role, id),
        readVendorPlan(id),
      ]);
      res.json({ stats: { totalServices, activeServices, pendingRequests: bookings.pending, acceptedBookings: bookings.accepted, plan } });
      return;
    }

    const [users, totalServices, pendingServices] = await Promise.all([
      adminUserCounts(),
      services.countDocuments(),
      services.countDocuments({ status: "pending" }),
    ]);
    res.json({ stats: { ...users, totalServices, pendingServices, transactions: null } });
  } catch {
    res.status(503).json({ message: "Dashboard statistics are temporarily unavailable." });
  }
});
