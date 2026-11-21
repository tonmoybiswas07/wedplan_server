import { json, Router, type ErrorRequestHandler } from "express";
import type { Filter } from "mongodb";
import { z } from "zod";
import { authenticateJwt, requireRole } from "./auth-middleware.js";
import { moderationUpdate, serializeService, serviceId, services, serviceStatuses, type Service } from "./services.js";

export const adminServices = Router();
adminServices.use(authenticateJwt, requireRole("admin"));

const query = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(serviceStatuses).optional(),
  page: z.string().regex(/^[1-9]\d{0,5}$/).default("1").transform(Number),
});
const PAGE_SIZE = 24;

adminServices.get("/", async (req, res) => {
  const parsed = query.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: "Check your search and status filter." });
    return;
  }
  const { q, status, page } = parsed.data;
  const filter: Filter<Service> = {};
  if (status) filter.status = status;
  if (q) {
    const text = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ title: text }, { category: text }, { description: text }];
  }

  const results = await services.find(filter).sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE + 1).toArray();
  res.json({ services: results.slice(0, PAGE_SIZE).map(serializeService), hasNext: results.length > PAGE_SIZE });
});

const moderation = z.object({ status: z.enum(["approved", "rejected"]) }).strict();

adminServices.patch("/:id/moderation", json({ limit: "2kb" }), async (req, res) => {
  const id = serviceId(req.params.id);
  if (!id) {
    res.status(404).json({ message: "Service not found." });
    return;
  }
  const body = moderation.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Choose approval or rejection." });
    return;
  }

  const updated = await services.findOneAndUpdate(
    body.data.status === "rejected" ? { _id: id } : { _id: id, status: { $ne: "approved" } },
    moderationUpdate(body.data.status),
    { returnDocument: "after" },
  );
  const service = updated ?? await services.findOne({ _id: id, status: body.data.status });
  if (!service) {
    res.status(404).json({ message: "Service not found or changed. Refresh and try again." });
    return;
  }
  res.json({ service: serializeService(service) });
});

const errors: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === "entity.parse.failed" || error?.type === "entity.too.large") {
    res.status(400).json({ message: "Check the moderation request." });
    return;
  }
  res.status(500).json({ message: "The moderation request could not be completed." });
};
adminServices.use(errors);
