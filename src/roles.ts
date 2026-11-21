export const roles = ["customer", "vendor", "admin"] as const;
export const signupRoles = ["customer", "vendor"] as const;

export function isRole(value: unknown): value is (typeof roles)[number] {
  return roles.some((role) => role === value);
}
