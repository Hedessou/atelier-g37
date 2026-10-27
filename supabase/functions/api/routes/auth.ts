import { z } from "zod";
import { sql as ksql } from "kysely";
import { compare, hash } from "bcryptjs";
import { db, sql } from "../lib/db.ts";
import { sendMail, smtpConfig } from "../lib/mail.ts";
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

// ---------- Mot de passe oublié : code à 6 chiffres envoyé par e-mail (27/10/2026) ----------
const RESET = { validMinutes: 15, maxAttempts: 5, maxPerWindow: 3, windowMinutes: 15 };
const forgotSchema = z.object({ email: z.string().email("E-mail invalide") });
const resetSchema = z.object({
  email: z.string().email("E-mail invalide"),
  code: z.string().regex(/^\d{6}$/, "Le code contient 6 chiffres"),
  password: z.string().min(8, "8 caractères minimum"),
  device: z.string().max(120).optional(),
});
const SENT_MSG = "Si un compte existe avec cet e-mail, un code vient d'y être envoyé. Regarde aussi dans les spams.";

function sixDigits(): string {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % 1000000).padStart(6, "0");
}

function resetMail(name: string, code: string) {
  const text = `Bonjour ${name},\n\nTon code pour choisir un nouveau mot de passe dans l'app Spinning R/F (Atelier G37) :\n\n${code}\n\nIl est valable ${RESET.validMinutes} minutes. Si tu n'as rien demandé, ignore ce message : ton mot de passe ne change pas.\n\n— Spinning R/F`;
  const html = `<!doctype html><html><body style="margin:0;background:#0f1b2d;font-family:Arial,Helvetica,sans-serif;color:#e8eef6">
<div style="max-width:480px;margin:0 auto;padding:28px 20px">
<div style="display:inline-block;background:#f59e0b;color:#1a1205;font-weight:700;border-radius:10px;padding:8px 10px;font-family:monospace">R/F</div>
<h1 style="font-size:20px;margin:18px 0 6px">Récupération de ton compte</h1>
<p style="color:#9fb0c6;line-height:1.5;margin:0 0 18px">Bonjour ${name.replace(/[<>&]/g, "")}, voici ton code pour choisir un nouveau mot de passe dans l'app Spinning R/F.</p>
<div style="background:#16263d;border:1px solid #2a3d58;border-radius:16px;padding:18px;text-align:center">
<div style="font-family:monospace;font-size:34px;letter-spacing:8px;font-weight:700;color:#fbbf24">${code}</div>
<div style="color:#9fb0c6;font-size:13px;margin-top:8px">Valable ${RESET.validMinutes} minutes</div></div>
<p style="color:#9fb0c6;font-size:13px;line-height:1.5;margin:18px 0 0">Si tu n'as rien demandé, ignore ce message : ton mot de passe ne change pas.</p>
</div></body></html>`;
  return { text, html };
}

export async function handleForgotPassword(request: Request): Promise<Response> {
  let email: string;
  try { email = forgotSchema.parse(await readSuperjson(request)).email.trim().toLowerCase(); } catch { return sj({ message: "E-mail invalide" }, 400); }
  const conf = await smtpConfig();
  if (!conf) return sj({ message: "La récupération par e-mail n'est pas encore activée. Demande à l'administrateur de réinitialiser ton mot de passe." }, 503);
  const since = new Date(Date.now() - RESET.windowMinutes * 60000);
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM password_resets WHERE lower(email) = ${email} AND created_at >= ${since}`;
  if (n >= RESET.maxPerWindow) return sj({ message: `Trop de demandes. Réessaie dans ${RESET.windowMinutes} minutes.` }, 429);
  const user = await db.selectFrom("users").select(["id", "email", "displayName", "firstName"]).where(ksql`lower(email)`, "=", email).executeTakeFirst();
  if (!user) return sj({ success: true, message: SENT_MSG });
  const code = sixDigits();
  const codeHash = await sha256(`${user.id}:${code}`);
  const [row] = await sql`INSERT INTO password_resets (user_id, email, code_hash, expires_at)
    VALUES (${user.id}, ${email}, ${codeHash}, ${new Date(Date.now() + RESET.validMinutes * 60000)}) RETURNING id`;
  try {
    const name = (user.firstName || user.displayName || "").trim().split(/\s+/)[0] || "";
    const { text, html } = resetMail(name, code);
    await sendMail(conf, { to: user.email, subject: `Ton code Spinning R/F : ${code}`, text, html });
  } catch (error) {
    console.error("Mot de passe oublié — envoi :", error);
    await sql`DELETE FROM password_resets WHERE id = ${row.id}`;
    return sj({ message: "L'e-mail n'a pas pu partir. Réessaie dans quelques minutes ou demande à l'administrateur." }, 502);
  }
  return sj({ success: true, message: SENT_MSG });
}

export async function handleResetPassword(request: Request): Promise<Response> {
  let input: z.infer<typeof resetSchema>;
  try { input = resetSchema.parse(await readSuperjson(request)); } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues[0]?.message : null;
    return sj({ message: msg || "Données invalides" }, 400);
  }
  const email = input.email.trim().toLowerCase();
  const [reset] = await sql`SELECT id, user_id, code_hash, expires_at, attempts FROM password_resets
    WHERE lower(email) = ${email} AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`;
  if (!reset || new Date(reset.expires_at).getTime() < Date.now()) return sj({ message: "Code expiré ou inconnu. Demande un nouveau code." }, 400);
  if (reset.attempts >= RESET.maxAttempts) return sj({ message: "Trop d'essais avec ce code. Demande un nouveau code." }, 429);
  if ((await sha256(`${reset.user_id}:${input.code}`)) !== reset.code_hash) {
    await sql`UPDATE password_resets SET attempts = attempts + 1 WHERE id = ${reset.id}`;
    const left = RESET.maxAttempts - reset.attempts - 1;
    return sj({ message: left > 0 ? `Code incorrect. Encore ${left} essai${left > 1 ? "s" : ""}.` : "Code incorrect. Demande un nouveau code." }, 400);
  }
  const userId = reset.user_id as number;
  const passwordHash = await hash(input.password, 10);
  const has = await db.selectFrom("userPasswords").select("userId").where("userId", "=", userId).executeTakeFirst();
  if (has) await db.updateTable("userPasswords").set({ passwordHash, createdAt: new Date() }).where("userId", "=", userId).execute();
  else await db.insertInto("userPasswords").values({ userId, passwordHash }).execute();
  await sql`UPDATE password_resets SET used_at = now() WHERE user_id = ${userId} AND used_at IS NULL`;
  // Toutes les anciennes connexions sont coupées : seul ce téléphone reste connecté.
  await db.deleteFrom("appSessions").where("userId", "=", userId).execute();
  await db.deleteFrom("loginAttempts").where("email", "=", email).execute();
  const user = await db.selectFrom("users").select(["id", "email", "displayName", "avatarUrl", "role"]).where("id", "=", userId).executeTakeFirst();
  const token = await createSession(userId, input.device ?? null);
  return sj({ user, token });
}
