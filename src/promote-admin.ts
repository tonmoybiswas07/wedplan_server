import { z } from "zod";

const email = z.email().safeParse(process.argv[2]?.trim().toLowerCase());

if (!email.success || process.argv.length !== 3) {
  console.error("Usage: npm run promote-admin -- user@example.com");
  process.exitCode = 1;
} else {
  const { client } = await import("./db.js");

  try {
    const { auth } = await import("./auth.js");
    if (!auth) throw new Error("Authentication is not configured.");

    const { adapter } = await auth.$context;
    const user = await adapter.update<{ role: string }>({
      model: "user",
      where: [{ field: "email", value: email.data }],
      update: { role: "admin" },
    });

    if (!user || user.role !== "admin") {
      console.error("No existing user found for that email.");
      process.exitCode = 1;
    } else {
      console.log("User has the Admin role.");
    }
  } catch {
    console.error("Unable to promote the account. Check the server auth and MongoDB configuration.");
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}
