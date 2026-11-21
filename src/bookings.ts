import { json, Router, type ErrorRequestHandler } from "express";
import { MongoServerError, type ObjectId } from "mongodb";
import { z } from "zod";
import { authenticateJwt, requireRole } from "./auth-middleware.js";
import { db } from "./db.js";
import { readPublishedService } from "./published-services.js";
import { serviceId } from "./services.js";

const activeStatuses = ["pending", "accepted", "confirmed"] as const;
type Booking = {
  customerId: string;
  vendorId: string;
  serviceId: ObjectId;
  serviceSnapshot?: { title: string; imageUrl?: string };
  customerName?: string;
  vendorName?: string;
  eventDate: string;
  eventLocation: string;
  message?: string;
  status: (typeof activeStatuses)[number] | "rejected" | "cancelled" | "completed";
  createdAt: Date;
  updatedAt: Date;
};

const bookings = db.collection<Booking>("bookings");
let bookingIndex: Promise<string> | undefined;

function ensureBookingIndex() {
  bookingIndex ??= bookings.createIndex(
    { customerId: 1, serviceId: 1, eventDate: 1 },
    {
      name: "one_active_booking_per_customer_service_date",
      unique: true,
      partialFilterExpression: { status: { $in: [...activeStatuses] } },
    },
  ).catch((error) => {
    bookingIndex = undefined;
    throw error;
  });
  return bookingIndex;
}

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

const bookingInput = z.object({
  serviceId: z.string().regex(/^[\da-f]{24}$/i, "Choose a valid service."),
  eventDate: z.iso.date().refine((date) => date >= today(), "Choose today or a future date."),
  eventLocation: z.string().trim().min(2, "Enter the event location.").max(160, "Use 160 characters or fewer."),
  message: z.string().trim().max(1000, "Use 1,000 characters or fewer.").optional(),
}).strict();

export const bookingRoutes = Router();

bookingRoutes.post("/", authenticateJwt, requireRole("customer"), json({ limit: "8kb" }), async (req, res) => {
  const parsed = bookingInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Check the booking details.", errors: z.flattenError(parsed.error).fieldErrors });
    return;
  }

  const { serviceId: identifier, eventDate, eventLocation, message } = parsed.data;
  const id = serviceId(identifier)!;
  const customerId = res.locals.user!.id;

  try {
    const listing = await readPublishedService(id);
    if (listing?.vendorId === customerId) {
      res.status(403).json({ message: "You can’t book your own service." });
      return;
    }
    if (!listing?.vendor[0]) {
      res.status(404).json({ message: "This service is unavailable." });
      return;
    }

    await ensureBookingIndex();
    const now = new Date();
    const booking: Booking = {
      customerId, vendorId: listing.vendorId, serviceId: id, eventDate, eventLocation,
      serviceSnapshot: { title: listing.title, ...(listing.imageUrl ? { imageUrl: listing.imageUrl } : {}) },
      customerName: res.locals.user!.name,
      vendorName: listing.vendor[0].name,
      ...(message ? { message } : {}), status: "pending", createdAt: now, updatedAt: now,
    };
    try {
      const { insertedId } = await bookings.insertOne(booking);
      res.status(201).json({ booking: { id: insertedId.toHexString(), status: booking.status } });
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      res.status(409).json({ message: "You already have an active request for this service on that date." });
    }
  } catch {
    res.status(503).json({ message: "The booking request could not be saved. Try again shortly." });
  }
});

type BookingRole = "customer" | "vendor";

function ownership(role: BookingRole, userId: string) {
  return role === "customer" ? { customerId: userId } : { vendorId: userId };
}

function bookingDetails(role: BookingRole) {
  const customerView = role === "customer";
  return [
    { $lookup: { from: "services", localField: "serviceId", foreignField: "_id", as: "listing" } },
    { $lookup: {
      from: "user",
      let: { accountId: { $convert: {
        input: customerView ? "$vendorId" : "$customerId", to: "objectId", onError: null, onNull: null,
      } } },
      pipeline: [
        { $match: { $expr: { $eq: ["$_id", "$$accountId"] } } },
        { $project: { _id: 0, name: 1, ...(!customerView ? { email: 1 } : {}) } },
      ],
      as: "participant",
    } },
    { $project: {
      _id: 0,
      id: { $toString: "$_id" },
      eventDate: 1, eventLocation: 1, createdAt: 1, status: 1,
      ...(!customerView ? { message: 1 } : {}),
      service: {
        title: { $ifNull: ["$serviceSnapshot.title", { $first: "$listing.title" }, "Service no longer listed"] },
        imageUrl: { $ifNull: ["$serviceSnapshot.imageUrl", { $first: "$listing.imageUrl" }, null] },
      },
      contact: {
        name: { $ifNull: [{ $first: "$participant.name" }, customerView ? "$vendorName" : "$customerName", "Account unavailable"] },
        ...(!customerView ? { email: { $ifNull: [{ $first: "$participant.email" }, null] } } : {}),
      },
    } },
  ];
}

const participants = requireRole("customer", "vendor");
const pages = z.object({ page: z.string().regex(/^[1-9]\d{0,5}$/).default("1").transform(Number) });
const PAGE_SIZE = 12;

bookingRoutes.get("/", authenticateJwt, participants, async (req, res) => {
  const page = pages.safeParse(req.query);
  if (!page.success) {
    res.status(400).json({ message: "Choose a valid page." });
    return;
  }
  const { id, role } = res.locals.user!;
  const bookingRole = role as BookingRole;
  const records = await bookings.aggregate([
    { $match: ownership(bookingRole, id) },
    { $sort: { createdAt: -1, _id: -1 } },
    { $skip: (page.data.page - 1) * PAGE_SIZE },
    { $limit: PAGE_SIZE + 1 },
    ...bookingDetails(bookingRole),
  ]).toArray();
  res.json({ bookings: records.slice(0, PAGE_SIZE), hasNext: records.length > PAGE_SIZE });
});

bookingRoutes.get("/counts", authenticateJwt, participants, async (_req, res) => {
  const { id, role } = res.locals.user!;
  const [counts] = await bookings.aggregate<{ total: number; pending: number }>([
    { $match: ownership(role as BookingRole, id) },
    { $group: { _id: null, total: { $sum: 1 }, pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } } } },
    { $project: { _id: 0, total: 1, pending: 1 } },
  ]).toArray();
  res.json({ counts: counts ?? { total: 0, pending: 0 } });
});

bookingRoutes.get("/:id", authenticateJwt, participants, async (req, res) => {
  const id = serviceId(req.params.id);
  const user = res.locals.user!;
  const role = user.role as BookingRole;
  const booking = id && await bookings.aggregate([
    { $match: { _id: id, ...ownership(role, user.id) } },
    ...bookingDetails(role),
  ]).next();
  if (!booking) {
    res.status(404).json({ message: "Booking not found." });
    return;
  }
  res.json({ booking });
});

const transition = z.object({ status: z.enum(["accepted", "rejected", "cancelled"]) }).strict();

bookingRoutes.patch("/:id/status", authenticateJwt, participants, json({ limit: "2kb" }), async (req, res) => {
  const result = transition.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ message: "Choose a valid booking action." });
    return;
  }

  const user = res.locals.user!;
  const { status } = result.data;
  if ((user.role === "customer") !== (status === "cancelled")) {
    res.status(403).json({ message: "You can’t perform this booking action." });
    return;
  }

  const id = serviceId(req.params.id);
  const owner = id && { _id: id, ...ownership(user.role as BookingRole, user.id) };
  if (!owner) {
    res.status(404).json({ message: "Booking not found." });
    return;
  }

  const changed = await bookings.updateOne(
    { ...owner, status: "pending" },
    { $set: { status, updatedAt: new Date() } },
  );
  if (changed.matchedCount) {
    res.json({ booking: { id: owner._id.toHexString(), status } });
    return;
  }

  if (await bookings.findOne(owner, { projection: { _id: 1 } })) {
    res.status(409).json({ message: "This booking has already been processed." });
  } else {
    res.status(404).json({ message: "Booking not found." });
  }
});

const bookingErrors: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === "entity.parse.failed" || error?.type === "entity.too.large") {
    res.status(400).json({ message: "Check the booking details." });
    return;
  }
  res.status(500).json({ message: "The booking request could not be completed." });
};
bookingRoutes.use(bookingErrors);
