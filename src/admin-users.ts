import { json, Router, type ErrorRequestHandler } from "express";
import { ObjectId, type Filter, type WithId } from "mongodb";
import { z } from "zod";
import { authenticateJwt, requireRole } from "./auth-middleware.js";
import { db } from "./db.js";
import { roles } from "./roles.js";

type UserRecord = {
  name: string;
  email: string;
  role: (typeof roles)[number];
  blocked?: boolean;
  updatedAt?: Date;
};

const users = db.collection<UserRecord>("user");
const projection = { name: 1, email: 1, role: 1, blocked: 1 };
const PAGE_SIZE = 20;
const query = z.object({
  q: z.string().trim().max(100).optional(),
  role: z.enum(roles).optional(),
  page: z.string().regex(/^[1-9]\d{0,5}$/).default("1").transform(Number),
});

function userId(value: string | string[] | undefined) {
  return typeof value === "string" && /^[\da-f]{24}$/i.test(value) ? new ObjectId(value) : null;
}

function publicAccount(user: WithId<UserRecord>) {
  return { id: user._id.toHexString(), name: user.name, email: user.email, role: user.role, blocked: user.blocked === true };
}

export async function adminUserCounts() {
  const [counts] = await users.aggregate<{ totalUsers: number; vendors: number; customers: number }>([
    { $group: {
      _id: null, totalUsers: { $sum: 1 },
      vendors: { $sum: { $cond: [{ $eq: ["$role", "vendor"] }, 1, 0] } },
      customers: { $sum: { $cond: [{ $eq: ["$role", "customer"] }, 1, 0] } },
    } },
    { $project: { _id: 0 } },
  ]).toArray();
  return counts ?? { totalUsers: 0, vendors: 0, customers: 0 };
}

export const adminUsers = Router();
adminUsers.use(authenticateJwt, requireRole("admin"));

adminUsers.get("/", async (req, res) => {
  const parsed = query.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: "Check the search and role filter." });
    return;
  }

  const { q, role, page } = parsed.data;
  const filter: Filter<UserRecord> = {};
  if (role) filter.role = role;
  if (q) {
    const literal = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: literal }, { email: literal }];
  }

  const result = await users.find(filter, { projection }).sort({ name: 1, _id: 1 })
    .skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE + 1).toArray();
  res.json({ users: result.slice(0, PAGE_SIZE).map(publicAccount), hasNext: result.length > PAGE_SIZE });
});

adminUsers.get("/:id", async (req, res) => {
  const _id = userId(req.params.id);
  const user = _id && await users.findOne({ _id }, { projection });
  if (!user) {
    res.status(404).json({ message: "User not found." });
    return;
  }
  res.json({ user: publicAccount(user) });
});

const status = z.object({ blocked: z.boolean() }).strict();

adminUsers.patch("/:id/status", json({ limit: "2kb" }), async (req, res) => {
  const _id = userId(req.params.id);
  const parsed = status.safeParse(req.body);
  if (!_id) {
    res.status(404).json({ message: "User not found." });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ message: "Choose whether to block or unblock this user." });
    return;
  }
  if (parsed.data.blocked && _id.toHexString() === res.locals.user.id) {
    res.status(409).json({ message: "You can’t block your own account." });
    return;
  }

  const user = await users.findOneAndUpdate({ _id }, {
    $set: { blocked: parsed.data.blocked, updatedAt: new Date() },
  }, { projection, returnDocument: "after" });
  if (!user) {
    res.status(404).json({ message: "User not found." });
    return;
  }

  res.json({ user: publicAccount(user) });
});

const errors: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === "entity.parse.failed" || error?.type === "entity.too.large") {
    res.status(400).json({ message: "Check the account status request." });
    return;
  }
  res.status(503).json({ message: "User management is temporarily unavailable." });
};
adminUsers.use(errors);
