// Appels à Gemini (plan gratuit) : réflexion faible (rapide, consomme peu), un modèle à la fois,
// modèle suivant seulement si le premier échoue. Limite gratuite atteinte partout → QuotaError.
import { config } from "./db.ts";

export class QuotaError extends Error {}

export type Part = { text: string } | { inline_data: { mime_type: string; data: string } };
export type Turn = { role: "user" | "model"; parts: Part[] };

const DEFAULT_MODELS = ["gemini-3.8-flash", "gemini-flash-latest", "gemini-3.5-flash", "gemini-flash-lite-latest"];

async function models(): Promise<string[]> {
  const env = Deno.env.get("GEMINI_MODEL");
  const custom = (await config("gemini.models")).split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...(env ? [env] : []), ...(custom.length ? custom : DEFAULT_MODELS)])];
}

// Modèles qui refusent le réglage « réflexion faible » : on ne le renvoie plus (mémoire de l'instance).
const noThinking = new Set<string>();

export async function gemini(contents: Turn[], opts: { system?: string; schema?: unknown; budgetMs?: number; perModelMs?: number; prefer?: string[] } = {}): Promise<string> {
  const key = Deno.env.get("GEMINI_API_KEY") || await config("gemini.api_key");
  if (!key) throw new Error("clé Gemini manquante");
  const started = Date.now();
  const budget = opts.budgetMs ?? 100_000;
  const errors: string[] = [];
  let quota = 0;
  for (const model of [...new Set([...(opts.prefer ?? []), ...await models()])]) {
    if (Date.now() - started > budget - 10_000) break;
    for (let withThinking = !noThinking.has(model); ; withThinking = false) {
      const generationConfig: Record<string, unknown> = { temperature: 0.2, responseMimeType: "application/json" };
      if (opts.schema) generationConfig.responseSchema = opts.schema;
      if (withThinking) generationConfig.thinkingConfig = { thinkingLevel: "low" };
      let res: Response;
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
            contents,
            generationConfig,
          }),
          signal: AbortSignal.timeout(Math.min(opts.perModelMs ?? 45_000, Math.max(5_000, budget - (Date.now() - started)))),
        });
      } catch (e) {
        errors.push(`${model}: ${e instanceof Error && e.name === "TimeoutError" ? "trop lent" : e}`);
        break;
      }
      if (res.ok) {
        const data = await res.json();
        const txt = data?.candidates?.[0]?.content?.parts?.filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text ?? "").join("") ?? "";
        if (txt.trim()) return txt.replace(/^\s*```(?:json)?|```\s*$/g, "").trim();
        errors.push(`${model}: réponse vide (${data?.candidates?.[0]?.finishReason ?? "?"})`);
        break;
      }
      const err = await res.json().catch(() => ({}));
      const msg = String(err?.error?.message ?? "");
      // Réglage de réflexion non accepté par ce modèle : on réessaie le même modèle sans ce réglage.
      if (res.status === 400 && withThinking && /think/i.test(msg)) { noThinking.add(model); continue; }
      if (res.status === 429) quota++;
      errors.push(`${model}: HTTP ${res.status} ${msg.slice(0, 80)}`);
      break;
    }
  }
  // Tous les modèles disponibles ont répondu « limite atteinte » (429) : c'est le quota gratuit.
  if (quota > 0 && errors.every((e) => /HTTP (429|404)/.test(e))) {
    throw new QuotaError(`limite gratuite atteinte (${errors.join(" | ")})`);
  }
  throw new Error(errors.join(" | ") || "aucun modèle disponible");
}

// Heure (au Bénin) où la limite gratuite revient : minuit à Los Angeles.
export function quotaResetHour(): string {
  const now = new Date();
  const la = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(now).reduce((o, p) => ({ ...o, [p.type]: p.value }), {} as Record<string, string>);
  const laAsUtc = Date.UTC(+la.year, +la.month - 1, +la.day, +la.hour % 24, +la.minute);
  const offset = laAsUtc - now.getTime(); // négatif : Los Angeles est en retard sur UTC
  const nextMidnightLa = Date.UTC(+la.year, +la.month - 1, +la.day + 1, 0, 0) - offset;
  const benin = new Date(nextMidnightLa + 3600_000);
  return `${benin.getUTCHours()} h${benin.getUTCMinutes() ? String(benin.getUTCMinutes()).padStart(2, "0") : ""}`;
}

export const quotaMessage = () =>
  `⏳ La limite gratuite de l'IA (Google) est atteinte pour aujourd'hui. Elle revient vers *${quotaResetHour()}*.\n` +
  `En attendant, les commandes marchent toujours : *!mc 25*, *!stock G41*, *!rapport*.`;

// ---------- Voix (synthèse vocale Gemini) : WAV en base64, ou "" si indisponible ----------
const DEFAULT_TTS = ["gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"];
export async function speak(text: string, voice = "Charon"): Promise<string> {
  const key = Deno.env.get("GEMINI_API_KEY") || await config("gemini.api_key");
  if (!key || !text.trim()) return "";
  const custom = (await config("gemini.tts_models")).split(",").map((s) => s.trim()).filter(Boolean);
  for (const model of custom.length ? custom : DEFAULT_TTS) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `Dis calmement, en français, d'une voix claire : ${text}` }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
        }),
        signal: AbortSignal.timeout(40_000),
      });
      if (!res.ok) { console.error("Voix", model, res.status, (await res.text()).slice(0, 200)); continue; }
      const data = await res.json();
      const part = data?.candidates?.[0]?.content?.parts?.find((p: { inlineData?: { data?: string } }) => p.inlineData?.data);
      if (!part) continue;
      const mime = String(part.inlineData.mimeType ?? "");
      const rate = Number(mime.match(/rate=(\d+)/)?.[1] ?? 24000);
      const pcm = Uint8Array.from(atob(part.inlineData.data), (c) => c.charCodeAt(0));
      return wavBase64(pcm, rate);
    } catch (e) { console.error("Voix", model, e); }
  }
  return "";
}

// PCM 16 bits mono → fichier WAV (en-tête de 44 octets), en base64.
export function wavBase64(pcm: Uint8Array, rate: number): string {
  const head = new DataView(new ArrayBuffer(44));
  const w = (o: number, s: string) => { for (let i = 0; i < 4; i++) head.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); head.setUint32(4, 36 + pcm.length, true); w(8, "WAVE"); w(12, "fmt ");
  head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 1, true);
  head.setUint32(24, rate, true); head.setUint32(28, rate * 2, true); head.setUint16(32, 2, true); head.setUint16(34, 16, true);
  w(36, "data"); head.setUint32(40, pcm.length, true);
  const all = new Uint8Array(44 + pcm.length);
  all.set(new Uint8Array(head.buffer), 0); all.set(pcm, 44);
  let bin = "";
  for (let i = 0; i < all.length; i += 0x8000) bin += String.fromCharCode(...all.subarray(i, i + 0x8000));
  return btoa(bin);
}
