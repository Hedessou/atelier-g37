import { db } from "./db.ts";

export const SESSION_DAYS = 180;

export class NotAuthenticatedError extends Error {
  constructor(message?: string) {
    super(message ?? "Not authenticated");
    this.name = "NotAuthenticatedError";
  }
}

export type SessionUser = { id: number; email: string; displayName: string; avatarUrl: string | null; role: "admin" | "user" };

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function tokenOf(request: Request): string {
  const direct = request.headers.get("x-g37-token")?.trim();
  if (direct) return direct;
  const auth = request.headers.get("authorization") ?? "";
  return auth.toLowerCase().startsWith("bearer g37_") ? auth.slice(7).trim() : "";
}

export async function createSession(userId: number, deviceLabel: string | null): Promise<string> {
  const token = `g37_${randomToken()}`;
  const now = new Date();
  await db.insertInto("appSessions").values({
    tokenHash: await sha256(token), userId, deviceLabel: deviceLabel?.slice(0, 120) ?? null,
    createdAt: now, lastSeen: now, expiresAt: new Date(now.getTime() + SESSION_DAYS * 86400000),
  }).execute();
  await db.updateTable("users").set({ lastSeen: now }).where("id", "=", userId).execute();
  return token;
}

export async function getServerUserSession(request: Request): Promise<{ user: SessionUser; session: { id: string } }> {
  const token = tokenOf(request);
  if (!token) throw new NotAuthenticatedError();
  const hash = await sha256(token);
  const row = await db.selectFrom("appSessions")
    .innerJoin("users", "users.id", "appSessions.userId")
    .select(["appSessions.tokenHash", "appSessions.lastSeen as sessionSeen", "appSessions.expiresAt", "users.id", "users.email", "users.displayName", "users.avatarUrl", "users.role"])
    .where("appSessions.tokenHash", "=", hash)
    .executeTakeFirst();
  if (!row || new Date(row.expiresAt).getTime() < Date.now()) throw new NotAuthenticatedError();
  const now = new Date();
  if (now.getTime() - new Date(row.sessionSeen).getTime() > 5 * 60000) {
    await db.updateTable("appSessions").set({ lastSeen: now, expiresAt: new Date(now.getTime() + SESSION_DAYS * 86400000) }).where("tokenHash", "=", hash).execute();
    await db.updateTable("users").set({ lastSeen: now }).where("id", "=", row.id).execute();
  }
  return { user: { id: row.id, email: row.email, displayName: row.displayName, avatarUrl: row.avatarUrl, role: row.role }, session: { id: hash } };
}
