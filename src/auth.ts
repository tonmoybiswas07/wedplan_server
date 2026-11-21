import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { betterAuth } from "better-auth/minimal";
import { jwt } from "better-auth/plugins/jwt";
import { z } from "zod";
import { db } from "./db.js";

const secret = process.env.BETTER_AUTH_SECRET;
if (secret && secret.length < 32) {
  throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
}

const baseURL = process.env.BETTER_AUTH_URL || `http://localhost:${process.env.PORT || 8000}`;
export const jwtClaims = { issuer: new URL(baseURL).origin, audience: new URL(baseURL).origin };

export const auth = secret ? betterAuth({
  secret,
  baseURL,
  database: mongodbAdapter(db),
  plugins: [jwt({
    jwks: { keyPairConfig: { alg: "EdDSA" } },
    jwt: { ...jwtClaims, expirationTime: "5m", definePayload: () => ({}) },
    disableSettingJwtHeader: true,
  })],
  emailAndPassword: { enabled: true },
  session: { disableSessionRefresh: true },
  advanced: { cookiePrefix: "wedplan" },
  user: {
    additionalFields: {
      role: {
        type: ["customer", "vendor"],
        required: true,
        validator: { input: z.enum(["customer", "vendor"]) },
      },
      blocked: { type: "boolean", input: false, required: false, defaultValue: false },
    },
  },
}) : null;
