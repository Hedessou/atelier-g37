import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Network } from "@capacitor/network";
import { API_BASE, BUNDLE_VERSION } from "./config";
import { session } from "./session";

// ---- État du réseau ----
let online = typeof navigator === "undefined" ? true : navigator.onLine;
const onlineListeners = new Set<(on: boolean) => void>();

function setOnline(next: boolean) {
  if (next === online) return;
  online = next;
  onlineListeners.forEach((l) => l(next));
}

export function isOnline() {
  return online;
}

export function onOnlineChange(l: (on: boolean) => void) {
  onlineListeners.add(l);
  return () => onlineListeners.delete(l);
}

export function useOnline() {
  const [on, setOn] = useState(online);
  useEffect(() => onOnlineChange(setOn), []);
  return on;
}

// ---- Appels au serveur ----
// Le code d'origine appelle « /_api/... » : on redirige ces appels vers le serveur Supabase,
// avec le jeton de session du téléphone.
let unauthorizedHandler: (() => void) | null = null;
export function onUnauthorized(handler: () => void) {
  unauthorizedHandler = handler;
}

export function installNetwork() {
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith("/_api/")) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const token = session.token();
    if (token) headers.set("x-g37-token", token);
    headers.set("x-app-version", BUNDLE_VERSION);
    const target = API_BASE + url.slice("/_api/".length);
    try {
      const res = await original(target, {
        ...init,
        headers,
        credentials: "omit",
        signal: init?.signal ?? AbortSignal.timeout(45000),
      });
      setOnline(true);
      if (res.status === 401 && !url.startsWith("/_api/auth/login") && !url.startsWith("/_api/auth/register") && token) {
        unauthorizedHandler?.();
      }
      return res;
    } catch (error) {
      // Pas de réseau (ou serveur injoignable) : l'app passe en mode hors ligne.
      if (!navigator.onLine) setOnline(false);
      throw new OfflineError(error instanceof Error ? error.message : String(error));
    }
  };

  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));
  if (Capacitor.isNativePlatform()) {
    Network.getStatus().then((s) => setOnline(s.connected)).catch(() => {});
    Network.addListener("networkStatusChange", (s) => setOnline(s.connected));
  }
}

export class OfflineError extends Error {
  constructor(message: string) {
    super(`Hors ligne : ${message}`);
    this.name = "OfflineError";
  }
}
