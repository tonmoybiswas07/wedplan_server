import "dotenv/config";
import cors from "cors";
import express from "express";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./auth.js";
import { authenticateJwt } from "./auth-middleware.js";
import { db } from "./db.js";
import { vendorServices } from "./vendor-services.js";
import { adminServices } from "./admin-services.js";
import { publicServices } from "./public-services.js";

const app = express();
const port = Number(process.env.PORT || 8000);

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
  ["/api/auth/get-session", "/api/auth/token", "/api/auth/jwks"],
  authHandler ?? authUnavailable,
);
app.post(
  ["/api/auth/sign-up/email", "/api/auth/sign-in/email", "/api/auth/sign-out"],
  authHandler ?? authUnavailable,
);

app.get("/api/me", authenticateJwt, (_req, res) => {
  res.json({ user: res.locals.user });
});

app.use("/api/vendor/services", vendorServices);
app.use("/api/admin/services", adminServices);
app.use("/api/services", publicServices);


app.get("/api/health", async (_req, res) => {
  try {
    await db.command({ ping: 1 });

    res.json({
      status: "ok",
      database: "connected",
    });
  } catch {
    res.status(503).json({
      status: "unavailable",
      database: "unreachable",
    });
  }
});

app.listen(port, () => {
  console.log(`WedPlan API running at http://localhost:${port}`);
});