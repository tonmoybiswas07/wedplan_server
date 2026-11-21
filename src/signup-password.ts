import { z } from "zod";

export const signupPassword = z.string()
  .min(6, "Use at least six characters.")
  .max(128, "Use no more than 128 characters.")
  .regex(/[A-Z]/, "Include an uppercase letter.")
  .regex(/[a-z]/, "Include a lowercase letter.");
