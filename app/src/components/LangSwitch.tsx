import React from "react";
import { Button } from "./Button";
import type { UiLang } from "../helpers/uiLang";

// Les deux boutons FR / EN, identiques à ceux de la barre de l'atelier.
export const LangSwitch = ({ lang, onChange }: { lang: UiLang; onChange: (l: UiLang) => void }) => (
  <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
    <Button size="sm" variant={lang === "fr" ? "primary" : "outline"} onClick={() => onChange("fr")}>FR</Button>
    <Button size="sm" variant={lang === "en" ? "primary" : "outline"} onClick={() => onChange("en")}>EN</Button>
  </div>
);

