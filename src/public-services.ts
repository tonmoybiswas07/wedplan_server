import { Router } from "express";
import { z } from "zod";
import type { Filter } from "mongodb";
import { authenticateJwt } from "./auth-middleware.js";
import { publishedServiceFilter, publicVendorLookup, readPublishedService } from "./published-services.js";
import { serviceId, services, type Service } from "./services.js";

const query = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(60).optional(),
  location: z.string().trim().max(100).optional(),
  sort: z.enum(["price-asc", "price-desc", "newest"]).default("newest"),
  page: z.string().regex(/^[1-9]\d{0,4}$/).default("1").transform(Number),
  limit: z.string().regex(/^(?:[1-9]|1[0-9]|2[0-4])$/).default("12").transform(Number),
});

function literal(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const publicServices = Router();

publicServices.get("/", async (req, res) => {
  const parsed = query.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: "Check the service filters." });
    return;
  }

  const { q, category, location, sort, page, limit } = parsed.data;
  const filter: Filter<Service> = { ...publishedServiceFilter };
  if (q) filter.title = new RegExp(literal(q), "i");
  if (category) filter.category = new RegExp(`^${literal(category)}$`, "i");
  if (location) filter.location = new RegExp(literal(location), "i");

  const order = sort === "newest" ? { createdAt: -1, _id: -1 } : { priceMinor: sort === "price-asc" ? 1 : -1, _id: 1 };

  try {
    const results = await services.aggregate([
      { $match: filter },
      { $sort: order },
      publicVendorLookup,
      { $unwind: "$vendor" },
      { $skip: (page - 1) * limit },
      { $limit: limit + 1 },
      {
        $project: {
          _id: 0,
          id: { $toString: "$_id" },
          title: 1,
          category: 1,
          priceMinor: 1,
          imageUrl: 1,
          location: 1,
          vendor: 1,
        },
      },
    ]).toArray();

    res.json({ services: results.slice(0, limit), hasNext: results.length > limit });
  } catch {
    res.status(503).json({ message: "Listings are temporarily unavailable." });
  }
});


publicServices.get("/:id", authenticateJwt, async (req, res) => {
  const id = serviceId(req.params.id);
  try {
    const listing = id && await readPublishedService(id);
    if (!listing || !listing.vendor[0]) {
      res.status(404).json({ message: "This service is unavailable." });
      return;
    }
    const { vendor, vendorId: _vendorId, ...service } = listing;
    res.json({ service: { ...service, vendor: vendor[0] } });
  } catch {
    res.status(503).json({ message: "Service details are temporarily unavailable." });
  }
});
