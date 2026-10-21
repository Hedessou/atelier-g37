import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type ManualChunk = { pageStart: number; pageEnd: number; content: string };

// Lit le texte du manuel PDF directement sur le téléphone, page par page,
// et le découpe en sections (~3 500 caractères) en gardant les numéros de page.
export async function extractManualChunks(file: File, onProgress?: (page: number, total: number) => void): Promise<ManualChunk[]> {
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const rows: ManualChunk[] = [];
  let buf: string[] = [];
  let len = 0;
  let start = 1;
  let last = 1;
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const text = content.items.map((i) => ("str" in i ? i.str : "")).join(" ").replace(/\s+/g, " ").trim();
    page.cleanup();
    onProgress?.(n, doc.numPages);
    if (!text) continue;
    if (len + text.length > 3500 && buf.length) {
      rows.push({ pageStart: start, pageEnd: last, content: buf.join("\n") });
      buf = [];
      len = 0;
    }
    if (!buf.length) start = n;
    buf.push(`[p.${n}] ${text}`);
    len += text.length;
    last = n;
  }
  if (buf.length) rows.push({ pageStart: start, pageEnd: last, content: buf.join("\n") });
  await doc.destroy();
  return rows;
}

// Envoie le texte au serveur par lots (le premier lot remplace l'ancien manuel).
export async function uploadManualChunks(chunks: ManualChunk[], fileName: string, onProgress?: (done: number, total: number) => void) {
  const size = 40;
  for (let i = 0; i < chunks.length; i += size) {
    const response = await fetch("/_api/g37/manual_import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chunks: chunks.slice(i, i + size), replace: i === 0, finalize: i + size >= chunks.length, sourceId: "g37-manual-text", fileName }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Import du manuel impossible.");
    onProgress?.(Math.min(i + size, chunks.length), chunks.length);
  }
}
