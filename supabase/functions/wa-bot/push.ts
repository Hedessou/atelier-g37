// Notification sur les téléphones des administrateurs (même canal que l'app G37 : Firebase).
import { config, sql } from "./db.ts";

type SA = { project_id: string; client_email: string; private_key: string; token_uri?: string };
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64text = (s: string) => b64url(new TextEncoder().encode(s));

async function serviceAccount(): Promise<SA | null> {
  const raw = Deno.env.get("FIREBASE_SERVICE_ACCOUNT") || await config("firebase.service_account");
  try { const sa = JSON.parse(raw); return sa.project_id && sa.client_email && sa.private_key ? sa : null; } catch { return null; }
}

async function accessToken(sa: SA): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const aud = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const header = b64text(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64text(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud, iat: now, exp: now + 3600 }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\\n/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`)));
  const res = await fetch(aud, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claim}.${b64url(sig)}` }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Jeton Firebase refusé (${res.status})`);
  return data.access_token;
}

export async function pushAdmins(title: string, body: string): Promise<number> {
  const sa = await serviceAccount();
  if (!sa) return 0;
  const rows = await sql`SELECT t.token, t.platform FROM push_tokens t JOIN users u ON u.id = t.user_id WHERE u.role = 'admin'`;
  if (!rows.length) return 0;
  const bearer = await accessToken(sa);
  const tag = `wa-robot-${Date.now()}`;
  let sent = 0;
  await Promise.all(rows.map(async (r) => {
    const modern = String(r.platform ?? "").startsWith("android3");
    const message = modern
      ? { token: r.token, data: { title, body, kind: "alert", tag }, android: { priority: "HIGH", ttl: "86400s" } }
      : { token: r.token, notification: { title, body }, data: { title, body, kind: "alert", tag }, android: { priority: "HIGH", notification: { channel_id: "g37_alertes", sound: "default", tag } } };
    try {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ message }),
      });
      if (res.ok) sent++; else console.error("FCM:", res.status, (await res.text()).slice(0, 200));
    } catch (e) { console.error("FCM:", e); }
  }));
  return sent;
}
