import type { RequestHandler, Response } from "express";
import { createLocalJWKSet, errors, jwtVerify } from "jose";
import { auth, jwtClaims } from "./auth.js";

type Role = "customer" | "vendor";

type AuthenticatedUser = {
  id: string;
  name: string;
  role: Role;
};

type AuthLocals = { user?: AuthenticatedUser };
type AuthHandler = RequestHandler<Record<string, string>, unknown, unknown, unknown, AuthLocals>;

function unauthorized(res: Response) {
  res.set("WWW-Authenticate", "Bearer").status(401).json({ error: "Unauthorized" });
}

export const authenticateJwt: AuthHandler = async (req, res, next) => {
  res.set("Cache-Control", "no-store");

  const token = /^Bearer ([^\s,]+)$/i.exec(req.get("authorization") ?? "")?.[1];
  if (!token) {
    unauthorized(res);
    return;
  }
  const authInstance = auth;
  if (!authInstance) {
    res.status(503).json({ error: "Authentication is not configured." });
    return;
  }

  try {
    const { payload } = await jwtVerify(token, async (...args) => {
      // Both routes use Better Auth's public key set without a request back to Express.
      const jwks = await authInstance.api.getJwks();
      return createLocalJWKSet(jwks)(...args);
    }, {
      ...jwtClaims,
      algorithms: ["EdDSA"],
      requiredClaims: ["sub", "exp"],
    });

    if (!payload.sub) {
      unauthorized(res);
      return;
    }

    const { adapter } = await authInstance.$context;
    const user = await adapter.findOne<{
      id: string;
      name: string;
      role?: unknown;
      blocked?: boolean;
    }>({
      model: "user",
      where: [{ field: "id", value: payload.sub }],
      select: ["id", "name", "role", "blocked"],
    });

    if (!user) {
      unauthorized(res);
      return;
    }
    if (user.blocked === true || (user.role !== "customer" && user.role !== "vendor")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    res.locals.user = { id: user.id, name: user.name, role: user.role };
    next();
  } catch (error) {
    if (error instanceof errors.JOSEError) {
      unauthorized(res);
      return;
    }
    res.status(503).json({ error: "Unable to verify authentication." });
  }
};

export function requireRole(role: Role): AuthHandler {
  return (_req, res, next) => {
    if (!res.locals.user) {
      unauthorized(res);
      return;
    }
    if (res.locals.user.role !== role) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}
