import { z } from "zod";

export const schema = z.object({});

export type InputType = z.infer<typeof schema>;

// La réponse est un fichier Excel (binaire), pas du JSON.
export type OutputType = Blob;

// Télécharge la sauvegarde Excel et renvoie le fichier + son nom.
export const getG37Export = async (init?: RequestInit): Promise<{ blob: Blob; fileName: string }> => {
  const r = await fetch("/_api/g37/export", { method: "GET", ...init });
  if (!r.ok) {
    let msg = "Export impossible";
    try {
      const j = await r.json();
      if (j?.error) msg = j.error;
    } catch { /* réponse non JSON */ }
    throw new Error(msg);
  }
  const cd = r.headers.get("Content-Disposition") ?? "";
  const m = /filename="([^"]+)"/.exec(cd);
  const fileName = m?.[1] ?? `sauvegarde-atelier-G37-${new Date().toISOString().slice(0, 10)}.xlsx`;
  return { blob: await r.blob(), fileName };
};

