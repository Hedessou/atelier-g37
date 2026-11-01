// Lecture des messages WhatsApp des groupes Ring Frame : numéro(s) de machine + type d'événement.
// Aucune dépendance : fonctionne dans Supabase (Deno) et se teste avec Node.

export type Kind = "fault" | "close" | "change" | "maint" | "ignore";
export type Parsed = { kind: Kind; machines: number[]; title: string; fromQuote: boolean; count?: string | null };

const MAX_MACHINE = 28;

// « R/F », « RF », « Rif », « Ring frame », « M/C », « MC », « Machine », suivis de « no », « N°», « number »… puis du numéro.
const PREFIX = String.raw`(?:r\s*\/\s*f|rf|rif|ring\s*fra?me?s?|m\s*\/\s*c|mc|machines?)`;
// « no », « nr », « num », « number », « numéro / numero » (01/11/2026 : « ring frame numéro 18 » était ignoré).
const NUMWORD = String.raw`(?:n(?:o|um(?:[ée]ro|ber)?|r)?\.?\s*)?`;
const NUMS = String.raw`(\d{1,2}(?:\s*(?:&|,|and|et|\/|-|to|à)\s*\d{1,2})*)`;
const MACHINE_RE = new RegExp(String.raw`\b${PREFIX}\s*[:#.\-]?\s*${NUMWORD}[:#.\-]?\s*${NUMS}(?!\d)`, "gi");
// Numéro écrit AVANT : « come to 17 mc », « 22 rf », « 5 m/c » (pas « 2 machines », qui est un nombre de machines).
const MACHINE_AFTER_RE = /(?<![\d.,:])\b(\d{1,2})\s*(?:r\s*\/\s*f|rf|m\s*\/\s*c|mc)\b/gi;

export function normalize(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\bn\s*[°º*]\s*/gi, "no ") // « N °26 », « N°26 », « n*22 »
    .replace(/[°º]/g, " ")
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractMachines(text: string): number[] {
  const out = new Set<number>();
  const t = normalize(text);
  for (const m of t.matchAll(MACHINE_RE)) {
    const group = m[1];
    // Plage « 21-24 » ou « 21 to 24 » ; sinon liste « 1&2 », « 3, 4 ».
    const range = group.match(/^(\d{1,2})\s*(?:-|to|à)\s*(\d{1,2})$/i);
    if (range) {
      const a = Number(range[1]), b = Number(range[2]);
      if (b > a && b - a <= 27) { for (let n = a; n <= b; n++) out.add(n); continue; }
    }
    for (const n of group.split(/\s*(?:&|,|and|et|\/|-|to|à)\s*/i)) {
      const v = Number(n);
      if (Number.isInteger(v) && v >= 1 && v <= MAX_MACHINE) out.add(v);
    }
  }
  for (const m of t.matchAll(MACHINE_AFTER_RE)) {
    const v = Number(m[1]);
    if (v >= 1 && v <= MAX_MACHINE) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function withoutMachineRefs(text: string): string {
  return normalize(text).replace(MACHINE_RE, " ").replace(MACHINE_AFTER_RE, " ").replace(/\s+/g, " ").trim();
}

const CHANGE_RE = /\b(count\s*chang\w*|count\s+(?:is\s+)?(?:going\s+to\s+be|will\s+be|to\s+be)\s+chang\w*|count\s*[:\-=]|lot\s*chang\w*|[gh]\s*gears?\s*chang\w*|gears?\s*chang\w*|changing|slip|pignons?|changement|article\s*chang\w*)\b/i;
const CLOSE_RE = /(?<![\p{L}\p{N}])(attend(?:ed)?|(?:re)?start(?:ed|ing|s)?|running|run|working|works|ok|okay|done|fixed|solved|resolved|repaired|finish(?:ed)?|r[ée]gl[ée]e?|r[ée]solue?|r[ée]par[ée]e?|d[ée]marr\p{L}*|red[ée]marr\p{L}*|en marche|marche|fonctionne|c'?est bon)(?![\p{L}\p{N}])/iu;
// « problem solved », « issue fixed », « panne réglée » : c'est une remise en marche, pas une nouvelle panne.
const SOLVED_RE = /\b(?:the\s+)?(?:problems?|issues?|fault|panne|probl[eè]me)\s+(?:is\s+|has\s+been\s+|est\s+|a\s+été\s+)?(solved|resolved|fixed|clear(?:ed)?|ok|r[ée]gl[ée]e?|r[ée]solue?)/giu;
// Mots qui montrent une demande ou un problème : le message n'est alors pas une remise en marche.
const REQUEST_RE = /\b(not|pas|issue|problems?|broken|break|cass\w*|come|check|help|please|pls|plz|kindly|need|stop(?:ped)?|jamm\w*|hot|missing|panne|arr[êe]t\w*|besoin|svp|veuillez)\b|n'/i;

// Maintenance périodique (« maintenance clg », « cleaning ») — mais pas « maintenance team ».
const MAINT_RE = /\b(clg|cleaning|nettoyage)\b|\bmaintenance\b(?!\s+team)/i;
const MAINT_DONE_RE = /\b(done|finish(?:ed)?|complet\w*|over|fait|termin\w*|ok|okay)\b/i;
// Message qui décrit un problème ou une demande (pas un travail fait).
export const hasRequestWords = (text: string) => REQUEST_RE.test(withoutMachineRefs(text)) || /\b(leak\w*|fuite|noise|bruit|vibration|smoke|fum[ée]e)\b/i.test(text);
export const isMaintText = (text: string) => MAINT_RE.test(withoutMachineRefs(text)) && !REQUEST_RE.test(withoutMachineRefs(text));

export function classifyText(text: string): Kind {
  const rest = withoutMachineRefs(text).toLowerCase();
  if (!rest) return "ignore";
  if (MAINT_RE.test(rest) && !REQUEST_RE.test(rest)) {
    // « Rf 10 maintenance clg finish » → maintenance faite ; « maintenance clg start » → rien à enregistrer.
    return MAINT_DONE_RE.test(rest) ? "maint" : "ignore";
  }
  const solved = rest.replace(SOLVED_RE, "$1");
  // « working on it », « in progress », « will start » : travail en cours, la panne reste ouverte.
  const pending = /\b(working\s+on|on\s+it|in\s+progress|en\s+cours|wait\w*|attente|soon|going\s+to|will|bient[oô]t)\b/i.test(solved);
  const close = CLOSE_RE.test(solved) && !REQUEST_RE.test(solved) && !pending;
  if (close) return "close";
  // Simple nouvelle d'un travail en cours (« Mc 25 working on it ») : ni fermeture, ni nouvelle panne.
  if (/^\W*(?:we\s+are\s+|we're\s+|i'?m\s+|am\s+)?(?:working\s+on\s+it|on\s+it|in\s+progress|en\s+cours)\W*$/i.test(solved)) return "ignore";
  if (CHANGE_RE.test(rest)) return "change";
  const words = rest.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  return words.length >= 1 ? "fault" : "ignore";
}

const FILLER = [
  /\bdear\b/gi, /\bhello\b/gi, /\bhi\b/gi, /\bgood\s+(?:morning|evening|afternoon)\b/gi,
  /\bmaintenance\s+team\b/gi, /\bmaintenance\b/gi, /\bteam\b/gi,
  /\b(?:we\s+)?need\s+your\s+help\b/gi, /\bneed\s+help\b/gi, /\bplease\b/gi, /\bpls\b/gi, /\bplz\b/gi, /\bkindly\b/gi,
  /\bcome\s+to\s+(?:check|see|arr?ange|repair|fix)(?:\s+(?:it|this|that))?\b/gi, /\bcome\b/gi,
  /\b(?:to\s+)?arr?ange\s+it\b/gi, /\bcheck\s+(?:this|it|that)\b/gi, /\bthis\s+issue\b/gi,
  /\bon\b(?=\s*[.,…]|\s*$)/gi, /\bhelp\b/gi, /\battend\b/gi, /\bcheck\b/gi, /\burgent(?:ly)?\b/gi,
];
const GENERIC = /^(?:the\s+)?(?:issue|problem|probl[eè]me|panne|it|this)$/i;

function tidy(s: string): string {
  return s.replace(/\.{2,}|…/g, " ").replace(/\s*[,;:.\-]+\s*/g, " ").replace(/\s+/g, " ").trim();
}

export function faultTitle(text: string): string {
  let s = withoutMachineRefs(text);
  for (const re of FILLER) s = s.replace(re, " ");
  s = tidy(s);
  // Mots orphelins laissés par le nettoyage (« Air pressure low I need to » → « Air pressure low »).
  const DANGLING = /^(?:i|we|to|need|needs|for|and|the|on|at|of|us|your|our|in)\b\s*|\s*\b(?:i|we|to|need|needs|for|and|the|on|at|of|us|your|our|in)$/i;
  for (let k = 0; k < 6 && DANGLING.test(s); k++) s = s.replace(DANGLING, "").trim();
  if (!s || s.length < 3 || GENERIC.test(s)) return "Panne à vérifier";
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
}

export function changeTitle(text: string): string {
  const t = normalize(text).toLowerCase();
  const parts: string[] = [];
  if (/count\s*chang|count\s+(?:is\s+)?(?:going\s+to\s+be|will\s+be|to\s+be)\s+chang/.test(t) || countLabel(text)) parts.push("Count change");
  if (/lot\s*chang/.test(t)) parts.push("Lot change");
  if (/article\s*chang|changement\s*d'?article/.test(t)) parts.push("Changement d'article");
  if (/\bslip\b/.test(t)) parts.push("Changing slip");
  const gear = t.match(/\b([gh])\s*gears?\b/);
  if (gear || /pignon/.test(t)) {
    const type = gear ? gear[1].toUpperCase() : "";
    // Détail des dentures tel qu'écrit (ex. « 104 off ~107~ »).
    const detail = normalize(text).match(/\b\d{2,3}\b[^\n]*?~?\d{2,3}~?/);
    parts.push(`Changement pignon${type ? " " + type : ""}${detail ? ` (${detail[0].trim()})` : ""}`);
  }
  if (!parts.length) return faultTitle(text);
  return parts.join(" · ").slice(0, 160);
}

// Count écrit dans le message : « Count change 12KW PRO » → « 12KW PRO », « COUNT : 60 CCW » → « 60 CCW ».
export function countLabel(text: string): string | null {
  const m = normalize(text).match(/count\s*(?:change)?\s*[:\-=]?\s*(\d{1,3}(?:[.,]\d+)?\s*[a-z]{1,5}(?:\s+(?!lot\b|change\b|ring\b|rf\b|r\/f\b|mc\b)[a-z]{2,4})?)\b/i);
  return m ? m[1].replace(/\s+/g, " ").trim().toUpperCase() : null;
}

// Titre du travail sur l'accueil : « Count change Mc 22 (12KW PRO) · Lot change ».
export function workTitle(p: Parsed, n: number): string {
  if (!p.title.startsWith("Count change")) return p.title;
  return p.title.replace(/^Count change/, `Count change Mc ${n}${p.count ? ` (${p.count})` : ""}`);
}

export function parseMessage(text: string, quoted?: string | null): Parsed {
  let kind = classifyText(text);
  let machines = extractMachines(text);
  let fromQuote = false;
  // Réponse du type « it's running » / « done » à un message qui citait la machine.
  if (!machines.length && quoted && (kind === "close" || kind === "change" || kind === "maint")) {
    machines = extractMachines(quoted);
    fromQuote = machines.length > 0;
    // « done » en réponse à « RF 10 maintenance clg » = maintenance faite.
    if (kind === "close" && /^(done|finish(?:ed)?|completed?|ok|okay|fait|termin\w*|c'?est bon)\W*$/i.test(normalize(text)) && isMaintText(quoted)) kind = "maint";
    // « Ok » seul en réponse à une demande (« Electric team come to check rf25 ») = « bien reçu », pas « ça remarche » (01/11/2026).
    else if (kind === "close" && /^\W*(ok|okay|d'?accord|noted|ok noted|bien re[çc]u)\W*$/i.test(normalize(text)) && hasRequestWords(quoted)) kind = "ignore";
  }
  if (!machines.length || kind === "ignore") return { kind: "ignore", machines: [], title: "", fromQuote: false };
  const title = kind === "fault" ? faultTitle(text) : kind === "change" ? changeTitle(text) : "";
  return { kind, machines, title, fromQuote, count: kind === "change" ? countLabel(text) : null };
}

// Ce qui a été fait, dans un message de remise en marche (« Mc 25 started, air filter changed » → « air filter changed »).
// Rien de plus que des mots de fermeture (« it's running ») → null.
const CLOSE_WORDS_G = new RegExp(CLOSE_RE.source, "giu");
const EMPTY_WORDS = /\b(it'?s|it|is|was|now|the|machine|mc|rf|ok|okay|thanks?|thank you|merci|and|et|has|been|a|été|est|la|le|c'?est|bon|problem|issue|panne|probl[eè]me|all|tout|good|fine|already|déjà)\b/giu;
export function solutionText(text: string): string | null {
  const base = withoutMachineRefs(text).replace(/\s+/g, " ").trim();
  const left = base.replace(CLOSE_WORDS_G, " ").replace(EMPTY_WORDS, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 2);
  if (left.length < 2) return null;
  return base.replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "").slice(0, 300);
}
