// Sécurité du mode « sans Internet » et des messages privés (WebCrypto, rien n'est envoyé en clair).
// - Chaque téléphone a deux paires de clés : une pour signer ses actions, une pour recevoir des messages privés.
// - Les paquets échangés entre téléphones sont chiffrés avec la clé de groupe de l'atelier.
// - Les messages privés sont chiffrés pour les téléphones du destinataire (et de l'expéditeur) uniquement.

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

export const b64u = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const fromB64u = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
};
export const toB64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromB64 = (s: string) => fromB64u(s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const h = new Uint8Array(await subtle().digest("SHA-256", bytes));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const pubOnly = (j: JsonWebKey): JsonWebKey => ({ kty: "EC", crv: "P-256", x: j.x, y: j.y });

// ---------- Identité du téléphone ----------
type StoredDevice = { deviceId: string; signPriv: JsonWebKey; signPub: JsonWebKey; encPriv: JsonWebKey; encPub: JsonWebKey };
export type Device = { deviceId: string; signPub: JsonWebKey; encPub: JsonWebKey; signKey: CryptoKey; encKey: CryptoKey };
const DEVICE_KEY = "g37.device";
let devicePromise: Promise<Device> | null = null;

export function deviceIdSync(): string | null {
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    return raw ? (JSON.parse(raw) as StoredDevice).deviceId : null;
  } catch {
    return null;
  }
}

export function getDevice(): Promise<Device> {
  if (devicePromise) return devicePromise;
  devicePromise = (async () => {
    let stored: StoredDevice | null = null;
    try {
      const raw = localStorage.getItem(DEVICE_KEY);
      stored = raw ? (JSON.parse(raw) as StoredDevice) : null;
    } catch {
      stored = null;
    }
    if (!stored) {
      const sign = (await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const encK = (await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"])) as CryptoKeyPair;
      const id = b64u(crypto.getRandomValues(new Uint8Array(12)));
      stored = {
        deviceId: `d_${id}`,
        signPriv: await subtle().exportKey("jwk", sign.privateKey),
        signPub: pubOnly(await subtle().exportKey("jwk", sign.publicKey)),
        encPriv: await subtle().exportKey("jwk", encK.privateKey),
        encPub: pubOnly(await subtle().exportKey("jwk", encK.publicKey)),
      };
      localStorage.setItem(DEVICE_KEY, JSON.stringify(stored));
    }
    const signKey = await subtle().importKey("jwk", stored.signPriv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const encKey = await subtle().importKey("jwk", stored.encPriv, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
    return { deviceId: stored.deviceId, signPub: stored.signPub, encPub: stored.encPub, signKey, encKey };
  })();
  devicePromise.catch(() => { devicePromise = null; });
  return devicePromise;
}

export async function signText(text: string): Promise<string> {
  const d = await getDevice();
  return b64u(new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, d.signKey, enc.encode(text))));
}

export async function verifyText(pubJwk: JsonWebKey, text: string, sig: string): Promise<boolean> {
  try {
    const key = await subtle().importKey("jwk", pubOnly(pubJwk), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await subtle().verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64u(sig), enc.encode(text));
  } catch {
    return false;
  }
}

// ---------- Paquets chiffrés (clé de groupe) ----------
async function gzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const MAGIC = [0x47, 0x33, 0x37, 0x01]; // "G37" + version

export async function sealPacket(groupKeyB64u: string, data: unknown): Promise<Uint8Array> {
  const key = await subtle().importKey("raw", fromB64u(groupKeyB64u), "AES-GCM", false, ["encrypt"]);
  const plain = enc.encode(JSON.stringify(data));
  const zipped = await gzip(plain);
  const body = zipped ?? plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, key, body));
  const out = new Uint8Array(4 + 1 + 12 + ct.length);
  out.set(MAGIC, 0);
  out[4] = zipped ? 1 : 0;
  out.set(iv, 5);
  out.set(ct, 17);
  return out;
}

export async function openPacket<T = unknown>(groupKeyB64u: string, bytes: Uint8Array): Promise<T | null> {
  try {
    if (bytes.length < 18 || MAGIC.some((m, i) => bytes[i] !== m)) return null;
    const key = await subtle().importKey("raw", fromB64u(groupKeyB64u), "AES-GCM", false, ["decrypt"]);
    const body = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: bytes.slice(5, 17) }, key, bytes.slice(17)));
    const plain = bytes[4] === 1 ? await gunzip(body) : body;
    return JSON.parse(dec.decode(plain)) as T;
  } catch {
    return null;
  }
}

// ---------- Messages privés (chiffrés de bout en bout) ----------
export type DmEnvelope = {
  v: 1;
  epk: JsonWebKey;
  iv: string;
  ct: string;
  keys: Array<{ d: string; iv: string; wk: string }>;
};

export async function sealDm(plain: unknown, recipients: Array<{ deviceId: string; encJwk: JsonWebKey }>): Promise<DmEnvelope> {
  const contentKeyRaw = crypto.getRandomValues(new Uint8Array(32));
  const contentKey = await subtle().importKey("raw", contentKeyRaw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, contentKey, enc.encode(JSON.stringify(plain))));
  const eph = (await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"])) as CryptoKeyPair;
  const keys: DmEnvelope["keys"] = [];
  const seen = new Set<string>();
  for (const r of recipients) {
    if (seen.has(r.deviceId)) continue;
    seen.add(r.deviceId);
    try {
      const pub = await subtle().importKey("jwk", pubOnly(r.encJwk), { name: "ECDH", namedCurve: "P-256" }, false, []);
      const wrapKey = await subtle().deriveKey({ name: "ECDH", public: pub }, eph.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
      const wiv = crypto.getRandomValues(new Uint8Array(12));
      const wk = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: wiv }, wrapKey, contentKeyRaw));
      keys.push({ d: r.deviceId, iv: b64u(wiv), wk: b64u(wk) });
    } catch {
      // clé de téléphone invalide : ignorée
    }
  }
  return { v: 1, epk: pubOnly(await subtle().exportKey("jwk", eph.publicKey)), iv: b64u(iv), ct: b64u(ct), keys };
}

export async function openDm<T = unknown>(env: DmEnvelope): Promise<T | null> {
  try {
    const d = await getDevice();
    const mine = env.keys.find((k) => k.d === d.deviceId);
    if (!mine) return null;
    const epk = await subtle().importKey("jwk", pubOnly(env.epk), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const wrapKey = await subtle().deriveKey({ name: "ECDH", public: epk }, d.encKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const raw = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: fromB64u(mine.iv) }, wrapKey, fromB64u(mine.wk)));
    const contentKey = await subtle().importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const plain = await subtle().decrypt({ name: "AES-GCM", iv: fromB64u(env.iv) }, contentKey, fromB64u(env.ct));
    return JSON.parse(dec.decode(plain)) as T;
  } catch {
    return null;
  }
}
