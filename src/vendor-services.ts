import { json, Router, type ErrorRequestHandler, type Request, type Response } from "express";
import multer from "multer";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { authenticateJwt, requireRole } from "./auth-middleware.js";
import { db } from "./db.js";

const fields = z.object({
  title: z.string().trim().min(3, "Enter at least 3 characters.").max(100),
  category: z.string().trim().min(2, "Enter a service category.").max(60),
  description: z.string().trim().min(10, "Enter at least 10 characters.").max(2000),
  price: z.preprocess((value) => typeof value === "number" ? String(value) : value, z.string().trim().regex(/^\d{1,8}(?:\.\d{1,2})?$/, "Enter a BDT amount with up to two decimal places.")
    .transform((value) => Math.round(Number(value) * 100))
    .refine((value) => value > 0, "Enter an amount greater than zero.")),
}).strict();

type Service = {
  vendorId: string;
  title: string;
  category: string;
  description: string;
  priceMinor: number;
  imageUrl?: string;
  status: "pending" | "approved" | "rejected";
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const services = db.collection<Service>("services");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4, fieldSize: 12 * 1024 },
}).single("image");

function ownedService(id: string | string[] | undefined, vendorId: string) {
  return typeof id === "string" && /^[\da-f]{24}$/i.test(id)
    ? { _id: new ObjectId(id), vendorId }
    : null;
}

function serialize({ _id, vendorId: _vendorId, ...service }: Service & { _id: ObjectId }) {
  return { id: _id.toHexString(), ...service };
}

function imageMime(bytes: Buffer) {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
}

async function readService(req: Request, res: Response) {
  const parsed = fields.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Check the service details.", errors: z.flattenError(parsed.error).fieldErrors });
    return;
  }

  let imageUrl: string | undefined;
  if (req.file) {
    const mime = imageMime(req.file.buffer);
    if (!mime) {
      res.status(400).json({ message: "Check the service image.", errors: { image: ["Choose a JPEG, PNG, or WebP image."] } });
      return;
    }

    const key = process.env.IMGBB_API_KEY?.trim();
    if (!key) {
      res.status(503).json({ message: "Image uploads are unavailable. You can save without a new photo." });
      return;
    }

    try {
      const body = new FormData();
      body.set("image", new Blob([Uint8Array.from(req.file.buffer)], { type: mime }), "service." + mime.split("/")[1]);
      const url = new URL("https://api.imgbb.com/1/upload");
      url.searchParams.set("key", key);
      const response = await fetch(url, { method: "POST", body, redirect: "error", signal: AbortSignal.timeout(15_000) });
      const result = await response.json();
      if (!response.ok || result.success !== true || typeof result.data?.url !== "string") throw new Error();
      const hosted = new URL(result.data.url);
      if (hosted.protocol !== "https:" || hosted.hostname !== "i.ibb.co") throw new Error();
      imageUrl = hosted.href;
    } catch {
      res.status(502).json({ message: "The image could not be uploaded. Try again or save without a new photo." });
      return;
    }
  }

  const { price, ...details } = parsed.data;
  return { ...details, priceMinor: price, ...(imageUrl ? { imageUrl } : {}) };
}

export const vendorServices = Router();
vendorServices.use(authenticateJwt, requireRole("vendor"));

vendorServices.get("/", async (_req, res) => {
  const results = await services.find({ vendorId: res.locals.user.id }).sort({ createdAt: -1, _id: -1 }).toArray();
  res.json({ services: results.map(serialize) });
});

vendorServices.get("/:id", async (req, res) => {
  const filter = ownedService(req.params.id, res.locals.user.id);
  const service = filter && await services.findOne(filter);
  if (!service) {
    res.status(404).json({ message: "Service not found." });
    return;
  }
  res.json({ service: serialize(service) });
});

const jsonBody = json({ limit: "32kb" });

vendorServices.post("/", jsonBody, upload, async (req, res) => {
  const details = await readService(req, res);
  if (!details) return;

  const now = new Date();
  const service: Service = {
    ...details, vendorId: res.locals.user.id, status: "pending", active: false, createdAt: now, updatedAt: now,
  };
  const { insertedId } = await services.insertOne(service);
  res.status(201).json({ service: serialize({ ...service, _id: insertedId }) });
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
  const details = await readService(req, res);
  if (!details) return;

  const updated = await services.findOneAndUpdate(filter, {
    $set: { ...details, status: "pending", active: false, updatedAt: new Date() },
  }, { returnDocument: "after" });
  if (!updated) {
    res.status(404).json({ message: "Service not found." });
    return;
  }
  res.json({ service: serialize(updated) });
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
    const message = error.code === "LIMIT_FILE_SIZE" ? "Choose an image under 5 MB." : "Check the service fields and upload only one image.";
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
