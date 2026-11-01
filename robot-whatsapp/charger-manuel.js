// Charge le manuel Rieter G 37 (fichier .jsonl) dans G37, pour l'assistant WhatsApp.
// Utilisation (dans C:\Bots\g37-whatsapp) :  node charger-manuel.js rieter_g37_manuel.jsonl
// On peut le relancer sans risque : les pages déjà chargées sont simplement remplacées.
const fs = require("fs");
const path = require("path");

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const file = process.argv[2] || "rieter_g37_manuel.jsonl";
const SOURCE = "Manuel Rieter G 37";
const MAX = 2000, OVERLAP = 300;

if (!fs.existsSync(file)) { console.log(`❌ Fichier introuvable : ${file}\nCopie le manuel dans ce dossier, puis relance.`); process.exit(1); }

// 1) Découpage : une page = un morceau ; les pages longues sont coupées en morceaux de 2000 caractères.
const FOOTER = /^\s*(G 37 OM|IV OM|[IVX]+ OM)\s*\|.*$/gm;
const chunks = [];
for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  let row; try { row = JSON.parse(line); } catch { continue; }
  const parts = String(row.content || "").split(/\[p\.(\d+)\]\s*\n?/);
  // parts = [avant, n°page, texte, n°page, texte, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const page = Number(parts[i]);
    const text = parts[i + 1].replace(FOOTER, "").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length < 80) continue;
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const title = lines.slice(0, 2).join(" / ").slice(0, 150);
    if (text.length <= MAX + 300) { chunks.push({ key: `rieter-g37:p${page}:0`, page, title, content: text }); continue; }
    let start = 0, k = 0;
    while (start < text.length) {
      let end = Math.min(text.length, start + MAX);
      if (end < text.length) { const nl = text.lastIndexOf("\n", end); if (nl > start + MAX / 2) end = nl; }
      chunks.push({ key: `rieter-g37:p${page}:${k++}`, page, title, content: (k > 1 ? `${title}\n` : "") + text.slice(start, end) });
      if (end >= text.length) break;
      start = Math.max(end - OVERLAP, start + 1);
    }
  }
}
console.log(`📖 ${chunks.length} morceaux à charger (${file}).`);

// 2) Envoi à G37 par paquets de 40.
async function send(batch) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${cfg.apiUrl}/knowledge`, {
        method: "POST", headers: { "x-wa-key": cfg.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ source: SOURCE, chunks: batch }), signal: AbortSignal.timeout(60_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } catch (e) {
      console.log(`   essai ${attempt}/3 raté : ${e.message}`);
      await new Promise((ok) => setTimeout(ok, 5000));
    }
  }
  throw new Error("envoi impossible");
}

(async () => {
  let last = null;
  for (let i = 0; i < chunks.length; i += 40) {
    last = await send(chunks.slice(i, i + 40));
    process.stdout.write(`\r   ${Math.min(i + 40, chunks.length)} / ${chunks.length} envoyés…`);
  }
  console.log(`\n✅ Manuel chargé : ${last ? last.total : 0} morceaux dans G37. L'assistant l'utilise tout de suite.`);
})().catch((e) => { console.log(`\n❌ ${e.message}. Vérifie Internet et relance la même commande (rien ne sera en double).`); process.exit(1); });
