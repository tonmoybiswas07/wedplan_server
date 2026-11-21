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

const bookingErrors: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === "entity.parse.failed" || error?.type === "entity.too.large") {
    res.status(400).json({ message: "Check the booking details." });
    return;
  }
  res.status(500).json({ message: "The booking request could not be completed." });
};
bookingRoutes.use(bookingErrors);
