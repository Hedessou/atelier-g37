import { useEffect, useState } from "react";

export type UiLang = "fr" | "en";
const KEY = "g37-language";

export function readLang(): UiLang {
  try {
    return (localStorage.getItem(KEY) as UiLang) || "fr";
  } catch {
    return "fr";
  }
}

// Même clé que l'atelier : la langue choisie à la connexion est conservée dans l'app, et inversement.
export function useLang() {
  const [lang, setLangState] = useState<UiLang>(() => readLang());
  useEffect(() => {
    try { localStorage.setItem(KEY, lang); } catch { /* stockage indisponible */ }
  }, [lang]);
  const t = (fr: string, en: string) => (lang === "fr" ? fr : en);
  return { lang, setLang: setLangState, t };
}

