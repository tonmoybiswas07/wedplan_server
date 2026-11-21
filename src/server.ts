import "dotenv/config";
import cors from "cors";
import express from "express";
import { db } from "./db.js";

const app = express();
const port = Number(process.env.PORT || 8000);

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
  }),
);

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