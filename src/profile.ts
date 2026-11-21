import { json, Router, type ErrorRequestHandler, type Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import multer from "multer";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { auth } from "./auth.js";
import { authenticateJwt, requireRole } from "./auth-middleware.js";
import { db } from "./db.js";
import { imageUpload, ImageUploadError, uploadImage } from "./image-upload.js";
import { signupPassword } from "./signup-password.js";
import { signupRoles } from "./roles.js";

const name = z.string().trim().min(2, "Enter at least two characters.").max(100, "Use 100 characters or fewer.");
const details = z.object({
  name,
  businessName: z.string().trim().max(120, "Use 120 characters or fewer.").optional(),
}).strict();
const registration = z.object({
  name,
  email: z.email(),
  password: signupPassword,
  role: z.enum(signupRoles),
}).strict();

export const profileRoutes = Router();

profileRoutes.patch("/", authenticateJwt, requireRole("customer", "vendor"), json({ limit: "4kb" }), imageUpload(2), async (req, res) => {
  const parsed = details.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Check the editable profile fields.", errors: z.flattenError(parsed.error).fieldErrors });
    return;
  }
  const user = res.locals.user!;
  if (user.role !== "vendor" && parsed.data.businessName !== undefined) {
    res.status(400).json({ message: "Only vendors can set a business name." });
    return;
  }

  const image = req.file ? await uploadImage(req.file) : undefined;
  const updated = await db.collection("user").findOneAndUpdate(
    { _id: new ObjectId(user.id), role: user.role, blocked: { $ne: true } },
    { $set: { ...parsed.data, ...(image ? { image } : {}), updatedAt: new Date() } },
    { returnDocument: "after", projection: { _id: 0, name: 1, image: 1, businessName: 1 } },
  );
  if (!updated) {
    res.status(403).json({ message: "This profile can no longer be updated." });
    return;
  }
  res.json({ user: updated });
});

profileRoutes.post("/sign-up", imageUpload(4), async (req, res) => {
  const parsed = registration.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Check your sign-up details.", errors: z.flattenError(parsed.error).fieldErrors });
    return;
  }
  if (!auth) {
    res.status(503).json({ message: "Authentication is not configured." });
    return;
  }
  const image = req.file ? await uploadImage(req.file) : undefined;
  const response = await auth.api.signUpEmail({
    body: { ...parsed.data, ...(image ? { image } : {}) },
    headers: fromNodeHeaders(req.headers),
    asResponse: true,
  });
  await relayAuthResponse(response, res);
});

export async function relayAuthResponse(response: globalThis.Response, res: Response) {
  for (const cookie of response.headers.getSetCookie()) res.append("Set-Cookie", cookie);
  for (const header of ["content-type", "location"]) {
    const value = response.headers.get(header);
    if (value) res.set(header, value);
  }
  res.set("Cache-Control", "no-store").status(response.status).send(await response.text());
}

const errors: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof ImageUploadError || error instanceof multer.MulterError) {
    const message = error instanceof ImageUploadError ? error.message : "Choose one image no larger than 5 MB.";
    res.status(error instanceof ImageUploadError ? error.status : 400).json({ message, errors: { image: [message] } });
    return;
  }
  res.status(500).json({ message: "The profile request could not be completed." });
};
profileRoutes.use(errors);
