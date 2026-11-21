import "dotenv/config";
import cors from "cors";
import express from "express";
import { MongoServerSelectionError } from "mongodb";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { auth } from "./auth.js";
import { authenticateJwt } from "./auth-middleware.js";
import { db } from "./db.js";
import { vendorServices } from "./vendor-services.js";
import { adminServices } from "./admin-services.js";
import { publicServices } from "./public-services.js";
import { bookingRoutes } from "./bookings.js";
import { adminUsers } from "./admin-users.js";
import { dashboardStats } from "./dashboard-stats.js";
import { googleAuth } from "./google-auth.js";
import { adminTransactions, stripeWebhook, vendorBilling } from "./billing-routes.js";
import { profileRoutes } from "./profile.js";
import { reconcileExpiredSubscriptions } from "./service-availability.js";

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
  }),
);

const authHandler = auth ? toNodeHandler(auth) : null;
const authUnavailable: express.RequestHandler = (_req, res) => {
  res.status(503).json({ error: "Authentication is not configured." });
};

// Keep role and blocked status out of public profile mutation endpoints.
app.get(
  ["/api/auth/get-session", "/api/auth/token"],
  async (req, res, next) => {
    if (!auth || !req.headers.cookie) return next();
    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (session?.user.blocked === true) {
        res.status(403).set("Cache-Control", "no-store").json({ error: "Forbidden" });
        return;
      }
      next();
    } catch {
      res.status(503).json({ message: "Unable to verify authentication." });
    }
  },
  authHandler ?? authUnavailable,
);
app.get(["/api/auth/jwks", "/api/auth/callback/google"], authHandler ?? authUnavailable);
app.use("/api/auth/google", googleAuth);
app.post(
  ["/api/auth/sign-up/email", "/api/auth/sign-in/email", "/api/auth/sign-out"],
  authHandler ?? authUnavailable,
);

app.get("/api/me", authenticateJwt, (_req, res) => {
  res.json({ user: res.locals.user });
});

app.use("/api/vendor/services", vendorServices);
app.use("/api/admin/services", adminServices);
app.use("/api/admin/users", adminUsers);
app.use("/api/dashboard/stats", dashboardStats);
app.use("/api/services", publicServices);
app.use("/api/bookings", bookingRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/stripe/webhook", stripeWebhook);
app.use("/api/vendor/billing", vendorBilling);
app.use("/api/admin/transactions", adminTransactions);

app.get("/api/cron/subscription-expiry", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.get("authorization") !== `Bearer ${secret}`) {
    res.sendStatus(401);
    return;
  }

  await reconcileExpiredSubscriptions();
  res.sendStatus(204);
});

app.get("/api/health", async (_req, res) => {
  try {
    await db.command({ ping: 1 });

    res.json({
      status: "ok",
      database: "connected",
    });
  } catch (error) {
    console.error("MongoDB health check failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      serverErrors: error instanceof MongoServerSelectionError
        ? Array.from(error.reason?.servers.values() ?? [], ({ error: serverError, type }) => ({
          type,
          name: serverError?.name,
          code: serverError?.code,
          cause: (serverError?.cause as NodeJS.ErrnoException | undefined)?.code,
        }))
        : undefined,
    });
    res.status(503).json({
      status: "unavailable",
      database: "unreachable",
    });
  }
});

export default app;
