// Clés du mode « sans Internet » (échanges Bluetooth / Wi-Fi entre téléphones).
// - Le serveur signe les données de l'atelier (ECDSA P-256) : un téléphone ne peut pas inventer de fausses données.
// - Une clé de groupe (AES-256) chiffre les paquets échangés : seuls les membres validés peuvent les lire.
// - Chaque utilisateur a un canal d'appel secret (signalisation des appels Internet).
// Toutes ces clés sont créées automatiquement au premier usage et gardées dans app_config (jamais exposée telle quelle).
import { sql } from "./db.ts";

const enc = new TextEncoder();

export const b64u = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64u = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

async function getConfig(key: string): Promise<string | null> {
  const rows = await sql`SELECT value FROM app_config WHERE key = ${key}`;
  return rows[0]?.value ?? null;
}

// Écrit seulement si absent, puis relit (deux requêtes simultanées obtiennent la même valeur).
async function getOrCreate(key: string, make: () => Promise<string>): Promise<string> {
  const existing = await getConfig(key);
  if (existing) return existing;
  const value = await make();
  await sql`INSERT INTO app_config (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO NOTHING`;
  return (await getConfig(key)) ?? value;
}

type SignKeys = { priv: CryptoKey; pubJwk: JsonWebKey };
let signKeys: SignKeys | null = null;

export async function serverSignKeys(): Promise<SignKeys> {
  if (signKeys) return signKeys;
  const privText = await getOrCreate("p2p.sign_priv", async () => {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    return JSON.stringify(await crypto.subtle.exportKey("jwk", kp.privateKey));
  });
  const privJwk = JSON.parse(privText) as JsonWebKey;
  const priv = await crypto.subtle.importKey("jwk", privJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const pubJwk: JsonWebKey = { kty: "EC", crv: "P-256", x: privJwk.x, y: privJwk.y, ext: true };
  signKeys = { priv, pubJwk };
  return signKeys;
}

// Signature du serveur sur un texte (format P1363, base64url) — vérifiable par l'app avec la clé publique.
export async function serverSign(text: string): Promise<string> {
  const { priv } = await serverSignKeys();
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, enc.encode(text));
  return b64u(new Uint8Array(sig));
}

export async function groupKey(): Promise<string> {
  return await getOrCreate("p2p.group_key", async () => b64u(crypto.getRandomValues(new Uint8Array(32))));
}

async function callSecret(): Promise<string> {
  return await getOrCreate("call.secret", async () => b64u(crypto.getRandomValues(new Uint8Array(32))));
}

// Nom du canal temps réel d'un utilisateur (impossible à deviner sans le secret du serveur).
export async function callTopic(userId: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", fromB64u(await callSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`call:${userId}`)));
  return `g37-call-${userId}-${b64u(mac.slice(0, 12))}`;
}

// Vérifie la signature d'une action faite hors ligne par un téléphone (clé publique enregistrée du téléphone).
export async function verifyDeviceSig(signJwk: JsonWebKey, payload: string, sigB64u: string): Promise<boolean> {
  try {
    const pub = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: signJwk.x, y: signJwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromB64u(sigB64u), enc.encode(payload));
  } catch {
    return false;
  }
}
