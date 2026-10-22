import { z } from "zod";
import { sql as ksql } from "kysely";
import { compare, hash } from "bcryptjs";
import { db } from "../lib/db.ts";
import { createSession, getServerUserSession, NotAuthenticatedError, sha256, tokenOf } from "../lib/session.ts";
import { readSuperjson, sj } from "../lib/http.ts";

const RATE = { maxFailedAttempts: 5, windowMinutes: 15, lockoutMinutes: 15 };
const loginSchema = z.object({ email: z.string().email("Email is required"), password: z.string().min(1, "Password is required"), device: z.string().max(120).optional() });
const registerSchema = z.object({ email: z.string().email("Email is required"), password: z.string().min(8, "Password must be at least 8 characters"), displayName: z.string().min(1, "Name is required"), device: z.string().max(120).optional() });
const changePasswordSchema = z.object({ current: z.string().min(1), next: z.string().min(8) });

export async function handleLogin(request: Request): Promise<Response> {
  try {
    const { email, password, device } = loginSchema.parse(await readSuperjson(request));
    const normalizedEmail = email.toLowerCase();
    const now = new Date();
    const windowStart = new Date(now.getTime() - RATE.windowMinutes * 60000);
    const failed = await db.selectFrom("loginAttempts")
      // deno-lint-ignore no-explicit-any
      .select([(eb: any) => eb.fn.countAll().as("n"), (eb: any) => eb.fn.max("attemptedAt").as("last")])
      .where("email", "=", normalizedEmail).where("success", "=", false).where("attemptedAt", ">=", windowStart)
      .executeTakeFirst();
    if (failed && Number(failed.n) >= RATE.maxFailedAttempts && failed.last) {
      const end = new Date(new Date(failed.last as Date).getTime() + RATE.lockoutMinutes * 60000);
      if (now < end) return sj({ message: `Trop d'essais. Compte bloqué encore ${Math.ceil((end.getTime() - now.getTime()) / 60000)} min.` }, 429);
    }
    const user = await db.selectFrom("users").innerJoin("userPasswords", "users.id", "userPasswords.userId")
      .select(["users.id", "users.email", "users.displayName", "users.avatarUrl", "users.role", "userPasswords.passwordHash"])
      .where(ksql`lower(users.email)`, "=", normalizedEmail).executeTakeFirst();
    if (!user || !(await compare(password, user.passwordHash))) {
      await db.insertInto("loginAttempts").values({ email: normalizedEmail, attemptedAt: now, success: false }).execute();
      return sj({ message: "Invalid email or password" }, 401);
    }
    await db.deleteFrom("loginAttempts").where("email", "=", normalizedEmail).where("success", "=", false).execute();
    const token = await createSession(user.id, device ?? null);
    return sj({ user: { id: user.id, email: user.email, displayName: user.displayName, avatarUrl: user.avatarUrl, role: user.role }, token });
  } catch (error) {
    console.error("Login:", error);
    return sj({ message: "Authentication failed" }, 400);
  }
}

export async function handleRegister(request: Request): Promise<Response> {
  try {
    const input = registerSchema.parse(await readSuperjson(request));
    const email = input.email.trim();
    const existing = await db.selectFrom("users").select("id").where(ksql`lower(email)`, "=", email.toLowerCase()).executeTakeFirst();
    if (existing) return sj({ message: "email already in use" }, 409);
    const passwordHash = await hash(input.password, 10);
    // deno-lint-ignore no-explicit-any
    const newUser = await db.transaction().execute(async (trx: any) => {
      // deno-lint-ignore no-explicit-any
      const [{ count }] = await trx.selectFrom("users").select((eb: any) => eb.fn.count("id").as("count")).execute();
      const role: "admin" | "user" = Number(count) === 0 ? "admin" : "user";
      const [u] = await trx.insertInto("users").values({ email, displayName: input.displayName, role }).returning(["id", "email", "displayName", "avatarUrl", "createdAt"]).execute();
      await trx.insertInto("userPasswords").values({ userId: u.id, passwordHash }).execute();
      return { ...u, role };
    });
    const token = await createSession(newUser.id, input.device ?? null);
    return sj({ user: newUser, token });
  } catch (error) {
    return sj({ message: error instanceof Error ? error.message : "Registration failed" }, 400);
  }
}

export async function handleSession(request: Request): Promise<Response> {
  try {
    const { user } = await getServerUserSession(request);
    return sj({ user });
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return sj({ error: "Not authenticated" }, 401);
    console.error("Session:", error);
    return sj({ error: "Session validation failed" }, 400);
  }
}

export async function handleLogout(request: Request): Promise<Response> {
  const token = tokenOf(request);
  if (token) {
    const h = await sha256(token);
    const pushToken = request.headers.get("x-push-token");
    if (pushToken) await db.deleteFrom("pushTokens").where("token", "=", pushToken).execute().catch(() => {});
    await db.deleteFrom("appSessions").where("tokenHash", "=", h).execute();
  }
  return sj({ success: true, message: "Logged out successfully" });
}

export async function handleChangePassword(request: Request): Promise<Response> {
  try {
    const { user, session } = await getServerUserSession(request);
    const input = changePasswordSchema.parse(await readSuperjson(request));
    const row = await db.selectFrom("userPasswords").select("passwordHash").where("userId", "=", user.id).executeTakeFirst();
    if (!row || !(await compare(input.current, row.passwordHash))) return sj({ message: "Mot de passe actuel incorrect." }, 400);
    await db.updateTable("userPasswords").set({ passwordHash: await hash(input.next, 10), createdAt: new Date() }).where("userId", "=", user.id).execute();
    await db.deleteFrom("appSessions").where("userId", "=", user.id).where("tokenHash", "!=", session.id).execute();
    return sj({ success: true });
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return sj({ message: "Authentification requise" }, 401);
    return sj({ message: error instanceof Error ? error.message : "Changement impossible" }, 400);
  }
}
