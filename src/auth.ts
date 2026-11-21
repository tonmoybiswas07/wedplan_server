import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { jwt } from "better-auth/plugins/jwt";
import { z } from "zod";
import { db } from "./db.js";
import { signupPassword } from "./signup-password.js";
import { roles, signupRoles } from "./roles.js";

const secret = process.env.BETTER_AUTH_SECRET;
if (secret && secret.length < 32) {
  throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
}

const productionDomain = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const baseURL = process.env.BETTER_AUTH_URL || (
  productionDomain ? `https://${productionDomain}` : `http://localhost:${process.env.PORT || 8000}`
);
export const jwtClaims = { issuer: new URL(baseURL).origin, audience: new URL(baseURL).origin };

export const clientOrigin = new URL(process.env.CLIENT_URL || "http://localhost:3000").origin;
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
export const googleEnabled = Boolean(googleClientId && googleClientSecret);

export const auth = secret ? betterAuth({
  secret,
  baseURL,
  trustedOrigins: [clientOrigin],
  onAPIError: { errorURL: `${clientOrigin}/sign-in?google=failed` },
  socialProviders: googleClientId && googleClientSecret ? {
    google: {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      redirectURI: `${clientOrigin}/api/auth/callback/google`,
      prompt: "select_account",
      disableIdTokenSignIn: true,
      requireEmailVerification: true,
    },
  } : {},
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-up/email") return;
      if (!z.enum(signupRoles).safeParse(ctx.body?.role).success) {
        throw new APIError("BAD_REQUEST", { message: "Choose Customer or Vendor." });
      }
      const password = signupPassword.safeParse(ctx.body?.password);
      if (!password.success) throw new APIError("BAD_REQUEST", { message: password.error.issues[0]?.message });

    }),
  },
  database: mongodbAdapter(db),
  plugins: [jwt({
    jwks: { keyPairConfig: { alg: "EdDSA" } },
    jwt: { ...jwtClaims, expirationTime: "5m", definePayload: () => ({}) },
    disableSettingJwtHeader: true,
  })],
  emailAndPassword: { enabled: true, minPasswordLength: 6 },
  session: { disableSessionRefresh: true },
  advanced: { cookiePrefix: "wedplan" },
  user: {
    additionalFields: {
      role: {
        type: [...roles],
        required: false,
        validator: { input: z.enum(signupRoles) },
      },
      businessName: { type: "string", required: false, input: false },
      blocked: { type: "boolean", input: false, required: false, defaultValue: false },
    },
  },
}) : null;
