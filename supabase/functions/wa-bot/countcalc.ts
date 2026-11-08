// Questions de count sur WhatsApp (03/11/2026) : réponse calculée, jamais devinée par l'IA.
// « Quels pignons pour count 40 ? », « Rf 12 passe en 60 CCW », « count 30 hank 0,85 », « draft 36,5 », « G41 H104 donne quoi ? »
// → draft visé, meilleurs couples G/H avec la marge (+0,01 %), count obtenu, et pour chaque dent : en stock ou non.
import { sql } from "./db.ts";
import { availableStock, DRAFT_K, draftOf, PER_MACHINE, proposeHMin, RANGE, type Stock } from "./gears.ts";
import { extractMachines, normalize } from "./parse.ts";

const DEFAULT_HANK = 0.83; // même valeur par défaut que l'écran Calcul de l'app

export type CountQuery = { count: number | null; hank: number | null; draft: number | null; g: number | null; h: number | null; machines: number[]; en: boolean };

const num = (s: string | undefined) => (s == null ? null : Number(s.replace(",", ".")));
const ok = (v: number | null, lo: number, hi: number) => v != null && Number.isFinite(v) && v >= lo && v <= hi;

/** Lit les nombres utiles d'une question. Renvoie null si ce n'est pas une question de count / draft / pignons. */
export function parseCountQuery(text: string): CountQuery | null {
  const t = normalize(text).replace(/(\d),(\d)/g, "$1.$2");
  const low = t.toLowerCase();
  const en = /\b(which|what|gear|gears|please|for|need|how)\b/i.test(low) && !/\b(quel\w*|pignons?|pour|faut|combien|donne)\b/i.test(low);

  let count: number | null = null;
  const c1 = low.match(/\bcount\s*(?:change\s*)?(?:de|of|=|:|en|to|is|est)?\s*(\d{1,3}(?:\.\d+)?)/);
  const c2 = low.match(/\bne\s*(\d{1,3}(?:\.\d+)?)\b/);
  const c3 = low.match(/\b(\d{1,3}(?:\.\d+)?)\s*(?:'?s\b|ne\b|cc[a-z]{0,3}\b|cw\b|kw\b|cm[a-z]{0,2}\b|ccl[a-z]?\b)/);
  for (const m of [c1, c2, c3]) if (m && ok(num(m[1]), 4, 200)) { count = num(m[1]); break; }

  let hank: number | null = null;
  const h1 = low.match(/\b(?:r\.?\s*)?hank\s*(?:de|of|=|:|is|est)?\s*(\d(?:\.\d+)?)/);
  const h2 = low.match(/\b(\d\.\d+)\s*(?:r\.?\s*)?hank\b/);
  for (const m of [h1, h2]) if (m && ok(num(m[1]), 0.2, 5)) { hank = num(m[1]); break; }

  let draft: number | null = null;
  const d1 = low.match(/\b(?:draft|[ée]tirage)\s*(?:total\s*)?(?:de|of|=|:|is|est)?\s*(\d{1,3}(?:\.\d+)?)/);
  if (d1 && ok(num(d1[1]), 5, 120)) draft = num(d1[1]);

  const gm = low.match(/\bg\s*[:=]?\s*(\d{2})\b/), hm = low.match(/\bh\s*[:=]?\s*(\d{2,3})\b/);
  const g = gm && ok(Number(gm[1]), RANGE.G[0], RANGE.G[1]) ? Number(gm[1]) : null;
  const h = hm && ok(Number(hm[1]), RANGE.H[0], RANGE.H[1]) ? Number(hm[1]) : null;

  if (count == null && draft == null && !(g && h)) return null;
  return { count, hank, draft, g, h, machines: extractMachines(text), en };
}

/** Vraie question (et pas une demande de modification « change le count de la 5 en 60 ») ? */
export function looksLikeQuestion(text: string): boolean {
  const t = normalize(text).toLowerCase();
  // Ordre de modification (« passe au gear précédent G36 H103 », « remets la 22 en G61 H98 ») : pas une question de calcul.
  if (!/\?/.test(t) && /\b(passe[rz]?|remet\w*|revien\w*|retour\w*|annule\w*|change[rz]?|mets?|mettre|modifie[rz]?|corrige[rz]?|set|put|revert|go back|back to)\b/.test(t)) return false;
  if (/\?|\b(quel\w*|which|what|combien|propos\w*|suggest\w*|calcul\w*|donne\w*|faut|need|possible|dispo\w*|pignons?|gears?|couples?|comment|how)\b/.test(t)) return true;
  // « count 40 », « draft 36,5 », « G41 H104 » envoyés seuls : c'est aussi une demande de calcul.
  return /^\W*(?:(?:rf|r\/f|mc)\s*\d{1,2}\W*)?(?:count|draft|ne|g\s*\d)/.test(t) && !/\b(change[rz]?|mets?|mettre|passe[rz]?|modifie[rz]?|set|update|finish\w*|done|fait|attend\w*)\b/.test(t);
}

const fr2 = (x: number) => x.toFixed(2).replace(".", ",");
/** Marge en % avec 2 décimales : « +0,01 % », « −0,35 % », « 0,00 % ». */
export const margin = (err: number) => {
  const v = Math.round(err * 10000) / 100;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2).replace(".", ",")} %`;
};

/** Liste compacte de dents : « G30–33, G36, G40 ». */
function teethList(type: "G" | "H", list: number[]): string {
  const s = [...new Set(list)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j - i >= 2 ? `${type}${s[i]}–${s[j]}` : j === i ? `${type}${s[i]}` : `${type}${s[i]}, ${type}${s[j]}`);
    i = j;
  }
  return parts.join(", ");
}

type Pair = { g: number; h: number; d: number; err: number };

/** Tous les couples dans la plage, triés par écart au draft visé. */
function allPairs(target: number, hMin: number): Pair[] {
  const out: Pair[] = [];
  for (let g = RANGE.G[0]; g <= RANGE.G[1]; g++) for (let h = hMin; h <= RANGE.H[1]; h++) {
    const d = draftOf(g, h);
    out.push({ g, h, d, err: (d - target) / target });
  }
  return out.sort((a, b) => Math.abs(a.err) - Math.abs(b.err));
}

async function machineInfo(nos: number[]) {
  if (!nos.length) return [];
  const rows = await sql`SELECT machine_no, run_g, run_h, run_count, run_hank FROM machines WHERE machine_no = ANY(${nos}) ORDER BY machine_no`;
  return rows.map((r) => {
    const g = r.run_g == null ? null : Number(r.run_g), h = r.run_h == null ? null : Number(r.run_h);
    const count = r.run_count == null ? null : Number(r.run_count);
    const d = g && h ? draftOf(g, h) : null;
    // Hank enregistré (tenu à jour par la base à chaque changement), sinon count ÷ draft.
    const hank = r.run_hank != null ? Number(r.run_hank) : d && count ? count / d : null;
    return { no: Number(r.machine_no), g, h, count, d, hank: hank && hank > 0.2 && hank < 5 ? hank : null };
  });
}

/** Réponse complète, prête à envoyer sur WhatsApp. */
export async function countAnswer(q: CountQuery): Promise<string> {
  const T = (fr: string, en: string) => (q.en ? en : fr);
  const mcs = await machineInfo(q.machines);
  const n = Math.max(1, mcs.length || q.machines.length);
  const need = PER_MACHINE * n;
  const stock: Stock = await availableStock(q.machines);
  const hMin = await proposeHMin();   // H75–88 seulement si l'admin les a autorisés
  const have = (k: string) => Math.max(0, stock.get(k) ?? 0);
  const okTooth = (k: string) => have(k) >= need;

  // Hank : celui de la question, sinon celui que la machine file aujourd'hui (count ÷ draft actuel), sinon 0,83.
  let hank = q.hank, hankFrom = T("donné", "given");
  if (hank == null) {
    const fromMc = mcs.find((m) => m.hank);
    if (fromMc?.hank) { hank = Math.round(fromMc.hank * 1000) / 1000; hankFrom = T(`celui de la Mc ${fromMc.no} aujourd'hui`, `current one on Mc ${fromMc.no}`); }
    else { hank = DEFAULT_HANK; hankFrom = T("par défaut — donne le hank si différent", "default — give the hank if different"); }
  }

  const lines: string[] = [];
  const head: string[] = [];
  for (const m of mcs) head.push(`*Mc ${m.no}* : ${T("actuellement", "now")} G${m.g ?? "?"} · H${m.h ?? "?"}${m.d ? ` → draft ${fr2(m.d)}` : ""}${m.count ? ` · count ${m.count}` : ""}`);

  // Cas « G41 H104 » sans count ni draft : on calcule ce que donne ce couple.
  if (q.count == null && q.draft == null && q.g && q.h) {
    const d = draftOf(q.g, q.h);
    lines.push(`🔩 *G${q.g} · H${q.h}* → draft *${fr2(d)}* · count ≈ *${fr2(d * hank)}* (hank ${fr2(hank).replace(/0$/, "")}, ${hankFrom})`);
    if (head.length) lines.unshift(...head, "");
    lines.push("", `📦 *${T("Stock", "Stock")}* (${T(`il faut ${need} pièces par dent`, `${need} pieces needed per gear`)}) :`);
    lines.push(`${okTooth(`G${q.g}`) ? "✅" : "❌"} G${q.g} : ${have(`G${q.g}`)} ${T("pièce(s)", "pc")}`);
    lines.push(`${okTooth(`H${q.h}`) ? "✅" : "❌"} H${q.h} : ${have(`H${q.h}`)} ${T("pièce(s)", "pc")}`);
    return lines.join("\n");
  }

  const target = q.draft ?? (q.count! / hank);
  // À écart égal (plusieurs couples donnent le même draft), on montre d'abord ceux dont les dents sont en stock, puis ceux qui gardent un pignon actuel.
  const avail = (p: Pair) => (okTooth(`G${p.g}`) ? 1 : 0) + (okTooth(`H${p.h}`) ? 1 : 0);
  const kept = (p: Pair) => mcs.some((m) => m.g === p.g || m.h === p.h) ? 1 : 0;
  const pairs = allPairs(target, hMin).sort((a, b) => (Math.round(Math.abs(a.err) * 1e5) - Math.round(Math.abs(b.err) * 1e5)) || (avail(b) - avail(a)) || (kept(b) - kept(a)));
  const best = pairs.slice(0, 5);
  const inStock = pairs.filter((p) => okTooth(`G${p.g}`) && okTooth(`H${p.h}`)).slice(0, 3);
  const cur = mcs.find((m) => m.g && m.h);
  const keeps = (p: Pair) => (cur ? (p.g === cur.g ? T(" · garde G actuel", " · keeps current G") : p.h === cur.h ? T(" · garde H actuel", " · keeps current H") : "") : "");
  const fmtPair = (p: Pair, i: number) => {
    const sg = okTooth(`G${p.g}`) ? "✅" : "❌", sh = okTooth(`H${p.h}`) ? "✅" : "❌";
    return `${i + 1}) *G${p.g} · H${p.h}* → draft ${fr2(p.d)} · count ${fr2(p.d * hank!)} · *${margin(p.err)}*\n     ${sg} G${p.g} (${have(`G${p.g}`)})  ${sh} H${p.h} (${have(`H${p.h}`)})${keeps(p)}`;
  };

  lines.push(`🎯 *${q.count != null ? `Count ${q.count}` : `Draft ${fr2(target)}`}*${q.count != null ? ` · hank ${String(hank).replace(".", ",")} (${hankFrom})` : ""}`);
  lines.push(`${T("Draft visé", "Target draft")} : *${fr2(target)}*  (draft = ${String(DRAFT_K).replace(".", ",")} × H ÷ G)`);
  if (head.length) lines.unshift(...head, "");
  if (target < draftOf(RANGE.G[1], hMin) || target > draftOf(RANGE.G[0], RANGE.H[1])) {
    lines.push("", `⚠️ ${T(`Ce draft est hors de portée des pignons G${RANGE.G[0]}–${RANGE.G[1]} / H${hMin}–${RANGE.H[1]}`, "This draft is out of the gear range")} (${fr2(draftOf(RANGE.G[1], hMin))} – ${fr2(draftOf(RANGE.G[0], RANGE.H[1]))}).`);
  }

  lines.push("", `📐 *${T("Meilleurs couples", "Best pairs")}* (${T("marge = écart au draft visé", "margin = deviation from target")}) :`);
  best.forEach((p, i) => lines.push(fmtPair(p, i)));

  const bestInStockShown = best.some((p) => okTooth(`G${p.g}`) && okTooth(`H${p.h}`));
  if (inStock.length && (!bestInStockShown || !(okTooth(`G${best[0].g}`) && okTooth(`H${best[0].h}`)))) {
    lines.push("", `📦 *${T("Meilleurs couples EN STOCK", "Best pairs IN STOCK")}* :`);
    inStock.forEach((p, i) => lines.push(fmtPair(p, i)));
  } else if (!inStock.length) {
    lines.push("", `❌ ${T("Aucun couple G/H en stock pour ce draft", "No G/H pair in stock for this draft")} (${need} ${T("pièces de chaque", "pieces each")}).`);
  }

  // Dents explicitement disponibles / non disponibles (celles des propositions), puis tout le stock utilisable.
  const shownG = [...new Set([...best, ...inStock].map((p) => p.g))];
  const shownH = [...new Set([...best, ...inStock].map((p) => p.h))];
  const yesT = [...shownG.filter((g) => okTooth(`G${g}`)).map((g) => `G${g} (${have(`G${g}`)})`), ...shownH.filter((h) => okTooth(`H${h}`)).map((h) => `H${h} (${have(`H${h}`)})`)];
  const noT = [...shownG.filter((g) => !okTooth(`G${g}`)).map((g) => `G${g} (${have(`G${g}`)})`), ...shownH.filter((h) => !okTooth(`H${h}`)).map((h) => `H${h} (${have(`H${h}`)})`)];
  lines.push("", `🧾 *${T("Dents de ces propositions", "Gears in these proposals")}* (${T(`${need} pièces nécessaires chacune`, `${need} pieces needed each`)}) :`);
  lines.push(`✅ ${T("Disponibles", "Available")} : ${yesT.join(", ") || T("aucune", "none")}`);
  lines.push(`❌ ${T("Non disponibles", "Not available")} : ${noT.join(", ") || T("aucune", "none")}`);
  const allG: number[] = [], allH: number[] = [];
  for (let g = RANGE.G[0]; g <= RANGE.G[1]; g++) if (okTooth(`G${g}`)) allG.push(g);
  for (let h = hMin; h <= RANGE.H[1]; h++) if (okTooth(`H${h}`)) allH.push(h);
  lines.push(`📦 ${T("Tout le stock utilisable", "All usable stock")} : ${teethList("G", allG) || T("aucun G", "no G")} · ${teethList("H", allH) || T("aucun H", "no H")}`);
  lines.push(`_${T("Stock moins les changements déjà en attente du bouton Fait.", "Stock minus changes already waiting for the Done button.")}_`);
  return lines.join("\n");
}

/** Bloc pour le contexte de l'IA (questions mêlées à autre chose). */
export async function countContext(text: string): Promise<string> {
  const q = parseCountQuery(text);
  if (!q) return "";
  return `${await countAnswer(q)}\n(Recopie ces chiffres tels quels : propositions, marges, et dents disponibles / non disponibles.)`;
}
