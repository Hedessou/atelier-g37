import { sql } from "./db.ts";
type ServiceAccount = { project_id: string; client_email: string; private_key: string; token_uri?: string };
export type PushMessage = { title: string; body: string; tag?: string; data?: Record<string, string | number> };

let cached: { token: string; exp: number } | null = null;

let saCache: { sa: ServiceAccount | null; at: number } | null = null;

function parseServiceAccount(raw: string | null | undefined): ServiceAccount | null {
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw) as ServiceAccount;
    return sa.project_id && sa.client_email && sa.private_key ? sa : null;
  } catch {
    console.error("Compte de service Firebase : JSON invalide.");
    return null;
  }
}

// Clé Firebase : secret FIREBASE_SERVICE_ACCOUNT, sinon app_config 'firebase.service_account' (lisible seulement par le serveur).
async function serviceAccount(): Promise<ServiceAccount | null> {
  const fromEnv = parseServiceAccount(Deno.env.get("FIREBASE_SERVICE_ACCOUNT"));
  if (fromEnv) return fromEnv;
  if (saCache && Date.now() - saCache.at < 5 * 60_000) return saCache.sa;
  try {
    const rows = await sql`SELECT value FROM app_config WHERE key = 'firebase.service_account'`;
    saCache = { sa: parseServiceAccount(rows[0]?.value as string | undefined), at: Date.now() };
  } catch (e) {
    console.error("Lecture de la clé Firebase impossible :", e);
    saCache = { sa: null, at: Date.now() };
  }
  return saCache.sa;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (s: string) => b64url(new TextEncoder().encode(s));

async function accessToken(sa: ServiceAccount): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const aud = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64urlText(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud, iat: now, exp: now + 3600 }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\\n/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`)));
  const res = await fetch(aud, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claim}.${b64url(sig)}` }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Jeton Firebase refusé (${res.status})`);
  cached = { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return cached.token;
}

export async function sendPush(tokens: string[], msg: PushMessage): Promise<{ sent: number; dead: string[] }> {
  const sa = await serviceAccount();
  if (!sa || tokens.length === 0) return { sent: 0, dead: [] };
  const bearer = await accessToken(sa);
  const data: Record<string, string> = { title: msg.title, body: msg.body };
  for (const [k, v] of Object.entries(msg.data ?? {})) data[k] = String(v);
  let sent = 0;
  const dead: string[] = [];
  for (let i = 0; i < tokens.length; i += 20) {
    await Promise.all(tokens.slice(i, i + 20).map(async (token) => {
      try {
        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          body: JSON.stringify({ message: { token, notification: { title: msg.title, body: msg.body }, data,
            android: { priority: "HIGH", notification: { channel_id: "g37_alertes", sound: "default", tag: msg.tag ?? undefined, default_vibrate_timings: true } } } }),
        });
        if (res.ok) { sent++; return; }
        const err = await res.text();
        if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT.*registration/i.test(err)) dead.push(token);
        else console.error("FCM refusé:", res.status, err.slice(0, 300));
      } catch (e) {
        console.error("FCM erreur:", e);
      }
    }));
  }
  return { sent, dead };
}

// Vérification : la clé Firebase est-elle présente et acceptée par Google ?
export async function pushSelfTest(): Promise<{ configured: boolean; projectId: string | null; tokenOk: boolean; error?: string }> {
  saCache = null;
  const sa = await serviceAccount();
  if (!sa) return { configured: false, projectId: null, tokenOk: false };
  try {
    cached = null;
    await accessToken(sa);
    return { configured: true, projectId: sa.project_id, tokenOk: true };
  } catch (e) {
    return { configured: true, projectId: sa.project_id, tokenOk: false, error: e instanceof Error ? e.message : String(e) };
  }
}
