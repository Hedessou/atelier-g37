// deno-lint-ignore-file no-explicit-any
import { z } from "zod";
import { db, sql } from "../lib/db.ts";
import { getServerUserSession } from "../lib/session.ts";
import { json } from "../lib/http.ts";

const schema = z.object({
  message: z.string().min(1).max(4000), language: z.enum(["fr", "en"]).default("fr"), context: z.string().max(120000).default(""),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4000) })).max(12).default([]),
});

const GLOSSARY: Record<string, string> = {
  graissage: "grease greasing lubrication", graisser: "grease lubrication", graisse: "grease", lubrification: "lubrication", lubrifier: "lubricate lubrication", huile: "oil",
  panne: "fault failure breakdown", pannes: "fault failure breakdown", alarme: "alarm", erreur: "error fault", entretien: "maintenance", nettoyage: "cleaning", nettoyer: "clean cleaning",
  securite: "safety", broche: "spindle", broches: "spindle", anneau: "ring", curseur: "traveller", rouleau: "roller", rouleaux: "roller", courroie: "belt", moteur: "motor",
  etirage: "draft drafting", meche: "roving", fil: "yarn", bobine: "bobbin", rupture: "break breakage", casse: "break breakage", reglage: "setting adjust", reglages: "setting adjust",
  remplacement: "replace replacement", remplacer: "replace", changer: "replace change", vitesse: "speed", pression: "pressure", capteur: "sensor", frein: "brake", arret: "stop",
  demarrage: "start", procedure: "procedure", couple: "torque", serrage: "tightening torque", piece: "spare part", pieces: "spare part", rechange: "spare", intervalle: "interval",
  periodicite: "interval", controle: "check inspection", verifier: "check", filtre: "filter", ventilateur: "fan", aspiration: "suction", levage: "lifting", roulement: "bearing",
  engrenage: "gear", pignon: "gear", chaine: "chain", vis: "screw", boulon: "bolt", ecrou: "nut", hauteur: "height", jauge: "gauge", calibre: "gauge", banc: "rail", rail: "rail",
  doffage: "doffing", doffer: "doffing", tension: "tension", temperature: "temperature",
};
const STOP = new Set(["quel", "quelle", "quels", "quelles", "est", "sont", "les", "des", "une", "dans", "sur", "pour", "avec", "comment", "role", "donne", "moi", "que", "qui", "quoi", "cette", "ces", "mon", "mes", "the", "and", "for", "what", "how", "faire", "fait", "peux", "peut"]);
const words = (...texts: string[]) => texts.join(" ").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));

function manualQuery(...texts: string[]) {
  const out = new Set<string>();
  for (const w of words(...texts)) { out.add(w); for (const e of (GLOSSARY[w] ?? "").split(" ")) if (e) out.add(e); }
  return [...out].slice(0, 20).join(" | ");
}
function manualFallbackTerms(...texts: string[]) {
  const terms = new Set<string>();
  for (const w of words(...texts)) for (const t of (GLOSSARY[w] ?? "").split(" ")) if (t.length >= 3) terms.add(t);
  return [...terms].slice(0, 12);
}

async function callGemini(system: string, message: string): Promise<string> {
  let key = Deno.env.get("GEMINI_API_KEY");
  if (!key) {
    const rows = await sql`SELECT value FROM app_config WHERE key = 'gemini.api_key'`;
    key = rows[0]?.value || undefined;
  }
  if (!key) throw Object.assign(new Error("Clé Gemini manquante"), { code: "NO_KEY" });
  // Plusieurs modèles essayés dans l'ordre ; la recherche Web est retirée si le quota gratuit ne la permet pas.
  const models = [...new Set([Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash", "gemini-flash-latest", "gemini-3.5-flash", "gemini-flash-lite-latest"])];
  let lastErr = "";
  let quotaHit = false;
  for (const model of models) {
    for (const withSearch of [true, false]) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: message }] }], ...(withSearch ? { tools: [{ google_search: {} }] } : {}), generationConfig: { maxOutputTokens: 4000, temperature: 0.3 } }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { const parts: any[] = data?.candidates?.[0]?.content?.parts ?? []; const text = parts.map((p) => String(p?.text ?? "")).join("\n").trim(); if (text) return text; }
      lastErr = `${model} ${res.status} ${data?.error?.message ?? ""}`.slice(0, 300);
      if (res.status === 429) { quotaHit = true; continue; } // sans la recherche Web
      break; // 400/404/503… : modèle suivant
    }
  }
  if (quotaHit) throw Object.assign(new Error("Quota Gemini dépassé"), { code: "OUT_OF_CREDITS" });
  throw new Error(`Gemini indisponible (${lastErr})`);
}

export async function handleAssistant(request: Request): Promise<Response> {
  let user;
  try { ({ user } = await getServerUserSession(request)); } catch { return json({ error: "Authentification requise." }, 401); }
  const account = await db.selectFrom("users").select(["pending", "role", "jobRole"]).where("id", "=", user.id).executeTakeFirst();
  if (!account || account.pending) return json({ error: "Compte en attente de validation." }, 403);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Question invalide." }, 400);
  const body = parsed.data;
  const now = new Date();
  const lastUser = [...body.history].reverse().find((h) => h.role === "user")?.text ?? "";
  let manualContext = "";
  try {
    const q = manualQuery(body.message, lastUser);
    let rows: any[] = [];
    if (q) rows = await sql`SELECT page_no, page_end, content FROM g37_manual_chunks WHERE tsv @@ to_tsquery('english', ${q}) ORDER BY ts_rank_cd(tsv, to_tsquery('english', ${q})) DESC LIMIT 10`;
    if (rows.length < 5) {
      const terms = manualFallbackTerms(body.message, lastUser);
      if (terms.length) {
        const fallback = await sql`SELECT page_no, page_end, content FROM g37_manual_chunks AS c WHERE EXISTS (SELECT 1 FROM unnest(${terms}::text[]) AS term WHERE c.content ILIKE '%' || term || '%') ORDER BY page_no ASC LIMIT 6`;
        const seen = new Set(rows.map((r) => `${r.page_no}:${r.content}`));
        for (const row of fallback) { const k = `${row.page_no}:${row.content}`; if (!seen.has(k)) { rows.push(row); seen.add(k); } }
      }
    }
    manualContext = rows.slice(0, 12).map((r) => `[MANUAL PAGES ${r.page_no}-${r.page_end ?? r.page_no}]\n${r.content}`).join("\n\n");
  } catch (error) { console.error("G37 manual retrieval:", error); }
  const conversation = body.history.slice(-8).map((h) => `${h.role === "user" ? "USER" : "ASSISTANT"}: ${h.text.slice(0, 1500)}`).join("\n");
  const system = [
    "You are the G37 / Rieter ring-spinning (G 37) industrial maintenance control-room assistant, an expert technician-engineer.",
    "Your job is to help operators, technicians, supervisors and managers make correct decisions from the G37 technical manual and the live workshop data supplied below.",
    "SOURCE PRIORITY (strict): 1) the G37 technical manual excerpts below — always read them first and base technical answers on them; 2) confirmed live workshop data; 3) authoritative web information only when the first two are insufficient. Never silently replace a manual value with a web value, and never invent a G37 value.",
    "When manual excerpts are provided, use them thoroughly: give exact values, units, tolerances, sequences, tools and safety warnings as written, translated faithfully into the user's language. If excerpts partly answer, say what the manual covers and what it does not. If the excerpts seem unrelated to the question, say so and do not force them.",
    "Think step by step on technical and diagnostic questions: identify the machine/group/component, check the manual excerpts, check workshop data (faults, maintenance, greasing, lubrication, scheduled works, gears, stock), then answer. Separate observed facts from possible causes; never present a hypothesis as a confirmed diagnosis.",
    "Use the supplied workshop context as the authoritative source for G37-specific facts. Search it carefully for the exact machine number, group, field or record before saying information is missing.",
    "If a requested G37 fact is truly absent from the manual excerpts and the context, say exactly what is missing. For general technical questions, use web search when external information would improve the answer, and clearly distinguish web-sourced general information from confirmed G37 facts.",
    "Never include URLs, clickable links, citations, citation markers, source lists or reference links in the final answer. Return clean technical prose.",
    "Prioritize safety and operational accuracy: for an active fault, identify the machine, severity, symptom, stop status and the most useful next action when those fields exist.",
    "When summarizing, distinguish clearly between OPEN/OVERDUE, DUE SOON, and OK. Do not confuse a scheduled date with a completed intervention.",
    "For calculations, Draft = 16.068 × H ÷ G and Count = Hank × Draft. For G/H recommendations, respect G 30–65 and H 89–113. Show the formula and rounded result when a calculation is requested.",
    "When asked about stock, compare quantity against minimumQuantity and explicitly identify shortages.",
    "When asked about maintenance, greasing, lubrication or scheduled works, use the actual dates in context (cyclePoints gives each point's interval in days) and calculate urgency from today's date. Today's server date is " + now.toISOString().slice(0, 10) + ".",
    "You cannot mutate workshop data. Explain which app section/action the user must use for a change.",
    "Answer in the language of the user's question (French by default, professional operational style). Use short headings/bullets when useful. For broad questions, give the most important actionable finding first.",
    "", "G37 TECHNICAL MANUAL — RETRIEVED EXCERPTS (highest priority):", manualContext || "No matching manual excerpt was retrieved for this question.",
    "", "LIVE WORKSHOP CONTEXT:", body.context, "", "RECENT CONVERSATION (for follow-up questions):", conversation || "(none)",
  ].join("\n");
  // Assistant illimité pour tous les membres validés.
  try {
    const raw = await callGemini(system, body.message);
    const answer = raw.replace(/https?:\/\/\S+/gi, "").replace(/\[[^\]]*\]\([^)]*\)/g, "").trim();
    return json({ answer });
  } catch (err) {
    const code = (err as any)?.code;
    if (code === "OUT_OF_CREDITS" || code === "NO_KEY") return json({ error: "Le moteur IA est temporairement indisponible.", code: "OUT_OF_CREDITS" }, 503);
    console.error("G37 assistant error:", err);
    return json({ error: err instanceof Error ? err.message : "Assistant indisponible pour le moment." }, 503);
  }
}
