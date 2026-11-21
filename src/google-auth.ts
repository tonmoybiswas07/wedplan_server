import { json, Router, type Request, type Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { auth, clientOrigin, googleEnabled, jwtClaims } from "./auth.js";
import { db } from "./db.js";
import { relayAuthResponse } from "./profile.js";
import { isRole, signupRoles } from "./roles.js";

export const googleAuth = Router();

googleAuth.post("/start", json({ limit: "2kb" }), async (req, res) => {
  if (!auth || !googleEnabled) {
    res.status(503).json({ message: "Google sign-in is not configured." });
    return;
  }
  const complete = new URL("/auth/complete", clientOrigin);
  const returnTo = req.body?.returnTo;
  if (typeof returnTo === "string" && /^\/services\/[\da-f]{24}$/i.test(returnTo)) {
    complete.searchParams.set("returnTo", returnTo);
  }
  const failure = new URL(req.body?.mode === "sign-up" ? "/sign-up" : "/sign-in", clientOrigin);
  failure.searchParams.set("google", "failed");
  if (complete.searchParams.has("returnTo")) failure.searchParams.set("returnTo", returnTo);

  try {
    const headers = fromNodeHeaders(req.headers);
    if (req.body?.mode === "link") {
      const session = await auth.api.getSession({ headers });
      const role = session?.user.role;
      if (!session || session.user.blocked || (role !== "customer" && role !== "vendor")) {
        res.status(403).json({ message: "Sign in to link your Google account." });
        return;
      }
      const profile = new URL(`/dashboard/${role}/profile-settings`, clientOrigin);
      const cancelled = new URL(profile);
      profile.searchParams.set("google", "linked");
      cancelled.searchParams.set("google", "failed");
      const response = await auth.api.linkSocialAccount({
        headers, body: { provider: "google", callbackURL: profile.href, errorCallbackURL: cancelled.href, disableRedirect: true },
        asResponse: true,
      });
      await relayAuthResponse(response, res);
      return;
    }
    const response = await auth.api.signInSocial({
      headers, body: { provider: "google", callbackURL: complete.href, errorCallbackURL: failure.href, disableRedirect: true },
      asResponse: true,
    });
    await relayAuthResponse(response, res);
  } catch {
    res.status(502).json({ message: "Google sign-in could not be started." });
  }
});

async function onboardingSession(req: Request, res: Response) {
  if (!auth) {
    res.status(503).json({ message: "Authentication is not configured." });
    return;
  }
  res.set("Cache-Control", "no-store");
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) {
    res.status(401).json({ message: "Sign in to continue." });
    return;
  }
  if (session.user.blocked === true) {
    res.status(403).json({ message: "Access denied." });
    return;
  }
  if (isRole(session.user.role)) return { id: session.user.id, needsRole: false };

  if (session.user.role != null) {
    res.status(403).json({ message: "This account cannot be set up." });
    return;
  }
  const { adapter } = await auth.$context;
  const linked = await adapter.findOne({
    model: "account",
    where: [{ field: "providerId", value: "google" }, { field: "userId", value: session.user.id }],
    select: ["id"],
  });
  if (!linked) {
    res.status(403).json({ message: "This account cannot be set up." });
    return;
  }

  return { id: session.user.id, needsRole: true };
}

googleAuth.get("/onboarding", async (req, res) => {
  const access = await onboardingSession(req, res);
  if (access) res.json({ needsRole: access.needsRole });
});

const selection = z.object({ role: z.enum(signupRoles) }).strict();

googleAuth.post("/onboarding", json({ limit: "2kb" }), async (req, res) => {
  if (req.get("origin") !== clientOrigin && req.get("origin") !== jwtClaims.issuer) {
    res.status(403).json({ message: "Access denied." });
    return;
  }
  const parsed = selection.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Choose Customer or Vendor." });
    return;
  }
  const access = await onboardingSession(req, res);
  if (!access) return;
  if (!access.needsRole) {
    res.status(409).json({ message: "Your account type is already set." });
    return;
  }
  const result = await db.collection("user").updateOne({
    _id: new ObjectId(access.id), role: null, blocked: { $ne: true },
  }, { $set: { role: parsed.data.role, updatedAt: new Date() } });

  if (!result.modifiedCount) {
    res.status(409).json({ message: "Your account type could not be set again." });
    return;
  }
  res.json({ ok: true });
});


googleAuth.use(((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === "entity.parse.failed" || error?.type === "entity.too.large") {
    res.status(400).json({ message: "Check the account setup request." });
    return;
  }
  res.status(503).json({ message: "Account setup is temporarily unavailable." });
}) satisfies import("express").ErrorRequestHandler);
