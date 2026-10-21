import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";

// Les liens externes (page de paiement, pièces jointes) s'ouvrent dans le navigateur du téléphone,
// sans quitter l'app.
export async function openExternal(url: string) {
  if (Capacitor.isNativePlatform()) {
    await Browser.open({ url, presentationStyle: "popover" });
  } else {
    window.open(url, "_blank", "noopener");
  }
}

export function installLinkHandling() {
  if (!Capacitor.isNativePlatform()) return;
  document.addEventListener("click", (event) => {
    const a = (event.target as HTMLElement | null)?.closest?.("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      event.preventDefault();
      void openExternal(href);
    }
  }, true);
  const originalOpen = window.open.bind(window);
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    const u = url ? String(url) : "";
    if (/^https?:\/\//i.test(u)) {
      void openExternal(u);
      return null;
    }
    return originalOpen(url, target, features);
  }) as typeof window.open;
}
