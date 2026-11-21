import { json, Router, type ErrorRequestHandler, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { authenticateJwt, requireRole } from "./auth-middleware.js";
import { imageUpload, ImageUploadError, uploadImage } from "./image-upload.js";
import { canonicalCategory } from "./categories.js";
import { changeAvailability } from "./service-availability.js";
import { moderationUpdate, serializeService, serviceId, services, type Service } from "./services.js";

const fields = z.object({
  title: z.string().trim().min(3, "Enter at least 3 characters.").max(100),
  category: z.string().trim().transform(canonicalCategory).refine((value) => value !== undefined, "Choose an assignment category."),
  location: z.string().trim().min(2, "Enter a city or service area.").max(100),
  description: z.string().trim().min(10, "Enter at least 10 characters.").max(2000),
  price: z.preprocess((value) => typeof value === "number" ? String(value) : value, z.string().trim().regex(/^\d{1,8}(?:\.\d{1,2})?$/, "Enter a BDT amount with up to two decimal places.")
    .transform((value) => Math.round(Number(value) * 100))
    .refine((value) => value > 0, "Enter an amount greater than zero.")),
}).strict();

const upload = imageUpload(5, 4);

function ownedService(id: Request["params"][string], vendorId: string) {
  const _id = serviceId(id);
  return _id ? { _id, vendorId } : null;
}

async function readService(req: Request, res: Response, requireImage: boolean) {
  const parsed = fields.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Check the service details.", errors: z.flattenError(parsed.error).fieldErrors });
    return;
  }

  const files = Array.isArray(req.files) ? req.files : [];
  const imageError = files.reduce((total, file) => total + file.size, 0) > 5 * 1024 * 1024
    ? "Choose images totalling 5 MB or less."
    : requireImage && !files.length ? "Upload at least one service image." : undefined;
  if (imageError) {
    res.status(400).json({ message: imageError, errors: { image: [imageError] } });
    return;
  }

  let images: string[];
  try {
    images = await Promise.all(files.map(uploadImage));
  } catch (error) {
    if (!(error instanceof ImageUploadError)) throw error;
    res.status(error.status).json({ message: error.message, errors: { image: [error.message] } });
    return;
  }

  const { price, category, ...details } = parsed.data;
  return {
    ...details, category: category!, priceMinor: price,
    ...(images.length ? { imageUrl: images[0], imageUrls: images } : {}),
  };
}

export const vendorServices = Router();
vendorServices.use(authenticateJwt, requireRole("vendor"));

vendorServices.get("/", async (_req, res) => {
  const results = await services.find({ vendorId: res.locals.user.id }).sort({ createdAt: -1, _id: -1 }).toArray();
  res.json({ services: results.map(serializeService) });
});

vendorServices.get("/:id", async (req, res) => {
  const filter = ownedService(req.params.id, res.locals.user.id);
  const service = filter && await services.findOne(filter);
  if (!service) {
    res.status(404).json({ message: "Service not found." });
    return;
  }
  res.json({ service: serializeService(service) });
});

const jsonBody = json({ limit: "32kb" });

vendorServices.post("/", jsonBody, upload, async (req, res) => {
  const details = await readService(req, res, true);
  if (!details) return;

  const now = new Date();
  const service: Service = {
    ...details, vendorId: res.locals.user.id, status: "pending", isActive: false, createdAt: now, updatedAt: now,
  };
  const { insertedId } = await services.insertOne(service);
  res.status(201).json({ service: serializeService({ ...service, _id: insertedId }) });
});

vendorServices.patch("/:id", async (req, res, next) => {
  const filter = ownedService(req.params.id, res.locals.user.id);
  if (!filter || !await services.findOne(filter, { projection: { _id: 1 } })) {
    res.status(404).json({ message: "Service not found." });
    return;
  }
  next();
}, jsonBody, upload, async (req, res) => {
  const filter = ownedService(req.params.id, res.locals.user.id)!;
  const existing = await services.findOne(filter, { projection: { imageUrl: 1, imageUrls: 1 } });
  const details = await readService(req, res, !existing?.imageUrl && !existing?.imageUrls?.length);
  if (!details) return;

  const review = moderationUpdate("pending");
  const updated = await services.findOneAndUpdate(filter, {
    ...review, $set: { ...details, ...review.$set },
  }, { returnDocument: "after" });
  if (!updated) {
    res.status(404).json({ message: "Service not found." });
    return;
  }
  res.json({ service: serializeService(updated) });
});

const availability = z.object({ isActive: z.boolean() }).strict();

vendorServices.patch("/:id/availability", jsonBody, async (req, res) => {
  const id = serviceId(req.params.id);
  if (!id) {
    res.status(404).json({ message: "Service not found." });
    return;
  }
  const body = availability.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Specify whether the service should be active." });
    return;
  }
  const result = await changeAvailability(res.locals.user.id, id, body.data.isActive);
  if (result.service) {
    res.json({ service: serializeService(result.service) });
  } else if (result.error === "missing") {
    res.status(404).json({ message: "Service not found." });
  } else {
    res.status(409).json({
      message: result.error === "limit"
        ? "The Free plan allows 3 active services. Deactivate a service before activating another."
        : "Only approved services can be activated.",
    });
  }
});

vendorServices.delete("/:id", async (req, res) => {
  const filter = ownedService(req.params.id, res.locals.user.id);
  if (!filter || !(await services.deleteOne(filter)).deletedCount) {
    res.status(404).json({ message: "Service not found." });
    return;
  }
  res.status(204).end();
});

const serviceErrors: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE" ? "Choose an image under 5 MB." : "Check the service fields and upload up to four images.";
    res.status(400).json({ message, errors: { image: [message] } });
    return;
  }
  if (error?.type === "entity.too.large") {
    res.status(413).json({ message: "The service details are too large." });
    return;
  }
  if (error?.type === "entity.parse.failed" || (error instanceof Error && /multipart|unexpected end|boundary/i.test(error.message))) {
    res.status(400).json({ message: "The submitted form could not be read." });
    return;
  }
  res.status(500).json({ message: "The service request could not be completed." });
};
vendorServices.use(serviceErrors);
