// Référentiel métier des 28 métiers à filer Rieter G37.
// Partagé par l'app et le serveur : aucune logique visuelle ici.

export type Perm =
  | "machine" | "gears" | "maint" | "grease" | "works"
  | "faultReport" | "faults"
  | "stock" | "stockManage" | "forum" | "chatModerate" | "eff" | "shifts" | "specs" | "roles";

export type GroupSpec = {
  id: string; from: number; to: number;
  ring: string; abc: string; lappet: string; fly: string; roll: string; saddle: string;
  bottomApron: string; topApron: string; cage: string; tape: string; tube: string; acl: string; cots: string;
};

const GROUPS: GroupSpec[] = [
  { id: "A", from: 1, to: 8, ring: "36 mm", abc: "39 mm", lappet: "1,8 mm", fly: "2,0 mm", roll: "48/70 mm", saddle: "57/68 mm", bottomApron: "72,5 × 30 × 1,05", topApron: "43,5 × 30 × 1,05", cage: "43 mm", tape: "2330 × 11", tube: "180 mm", acl: "160 mm", cots: "Av 19×32×28,5 (63/70/75°Sh) · Ar 19×32×28,5 (75°Sh) · Mil 19×27×28,5 (83°Sh)" },
  { id: "B", from: 9, to: 11, ring: "40 mm", abc: "43 mm", lappet: "1,8 mm", fly: "2,2 mm", roll: "42,5/70 mm", saddle: "52/68 mm", bottomApron: "72,5 × 30 × 1,05", topApron: "39,2 × 30 × 1,05", cage: "36 mm", tape: "2330 × 11", tube: "180 mm", acl: "140 mm", cots: "Av 19×32×28,5 (78°Sh) · Ar 19×32×28,5 (83°Sh) · Mil 19×27×28,5 (83°Sh)" },
  { id: "C", from: 12, to: 13, ring: "36 mm", abc: "39 mm", lappet: "1,8 mm", fly: "2,0 mm", roll: "42,5/70 mm", saddle: "52/68 mm", bottomApron: "72,5 × 30 × 1,05", topApron: "39,2 × 30 × 1,05", cage: "36 mm", tape: "2330 × 11", tube: "200 mm", acl: "140 mm", cots: "Av 19×32×28,5 (63°Sh) · Ar 19×32×28,5 (75°Sh) · Mil 19×27×28,5 (83°Sh)" },
  { id: "D", from: 14, to: 20, ring: "36 mm", abc: "39 mm", lappet: "3,5 mm", fly: "2,0 mm", roll: "42,5/70 mm", saddle: "52/68 mm", bottomApron: "72,5 × 30 × 1,05", topApron: "38,1 × 30 × 1,05", cage: "36 mm", tape: "2330 × 11", tube: "180 mm", acl: "180 mm", cots: "Av grand 19×41,0×20 (63°Sh) · Av petit 19×30×25 (63°Sh)" },
  { id: "E", from: 21, to: 28, ring: "45 mm", abc: "48 mm", lappet: "3,5 mm", fly: "2,2 mm", roll: "42,5/70 mm", saddle: "52/68 mm", bottomApron: "72,5 × 30 × 1,05", topApron: "39,2 × 30 × 1,05", cage: "36 mm", tape: "2360 × 11", tube: "230 mm", acl: "140 mm", cots: "Av 19×32×28,5 (75°Sh) · Ar 19×32×28,5 (75°Sh) · Mil 19×27×28,5 (83°Sh)" },
];

const SPEC_LABELS: Array<[keyof GroupSpec, string]> = [
  ["ring", "Ring Dia — anneau"],
  ["abc", "ABC Ring — anti-ballon"],
  ["lappet", "Lappet Hook — guide-fil"],
  ["fly", "Fly Catcher — attrape-bourre"],
  ["roll", "Roll Gauge — jauge rouleaux"],
  ["saddle", "Saddle Gauge — jauge de selle"],
  ["bottomApron", "Bottom Apron — manchon inf."],
  ["topApron", "Top Apron — manchon sup."],
  ["cage", "Cage — barrette"],
  ["tape", "Spindle Tape — sangle"],
  ["tube", "Tube Length — cannette"],
  ["acl", "ACL — pas broches"],
  ["cots", "Cots — manchons de pression"],
];

const GREASE_POINTS = [
  { k: "nipples", n: "Nipples", d: 30 },
  { k: "front", n: "Front rollers", d: 15 },
  { k: "blackmiddle", n: "Black & middle rollers", d: 30 },
  { k: "mainshaft", n: "Main shaft", d: 365 },
  { k: "screwrod", n: "Screw rod", d: 30 },
  { k: "gearing", n: "All gearing", d: 30 },
];

const LUB_BOXES = [
  { k: "drafting", n: "Drafting gear box", d: 30 },
  { k: "ringrail", n: "Ring rail gear box", d: 30 },
  { k: "doffer", n: "Doffer gear box", d: 30 },
  { k: "servodisc", n: "Servodisc gear box", d: 30 },
];

// Exceptions d'intervalle sur certaines machines.
const CYCLE_OVERRIDES = [
  { kind: "grease", point: "front", from: 21, to: 28, d: 7 },
];

// `tabs` restreint ce que le poste voit. Absent = accès à tout l'écran.
const ROLES: Record<string, { n: string; p: Perm[]; code?: boolean; tabs?: string[] }> = {
  admin: { n: "Admin", p: ["machine", "gears", "maint", "grease", "works", "faultReport", "faults", "stock", "stockManage", "forum", "chatModerate", "eff", "shifts", "specs", "roles"] },
  superviseur: { n: "Superviseur", p: ["machine", "gears", "maint", "grease", "works", "faultReport", "faults", "stock", "stockManage", "forum", "chatModerate", "eff", "shifts", "specs"], code: true },
  technicien: { n: "Technicien", p: ["machine", "gears", "maint", "grease", "works", "faultReport", "faults", "stock", "forum", "eff"], code: true },
  shift: { n: "Shift technician", p: ["machine", "gears", "works", "faultReport", "faults", "stock", "forum", "eff"] },
  genmaint: { n: "Responsable maintenance générale", p: ["maint", "works", "faultReport", "faults", "stock", "forum"] },
  greaser: { n: "Opérateur graissage", p: ["grease", "works", "faultReport", "faults", "stock", "forum"] },
  manager: { n: "Manager", p: ["machine", "gears", "maint", "grease", "works", "faultReport", "faults", "stock", "forum", "eff", "shifts", "specs"], code: true },
  forman: { n: "Boss", p: ["machine", "gears", "maint", "grease", "works", "faultReport", "faults", "stock", "eff", "shifts", "specs"], code: true },
  prodsup: { n: "Prod superviseur", p: ["faultReport"], tabs: ["accueil", "calcul", "pannes", "gears", "discussion", "quarts"] },
  // Mêmes accès que Prod superviseur.
  prodman: { n: "Prod manager", p: ["faultReport"], tabs: ["accueil", "calcul", "pannes", "gears", "discussion", "quarts"] },
  helper: { n: "Helper", p: ["faultReport"] },
};

const TEAMS = ["A", "B", "C"] as const;

const SHIFT_TYPES = [
  { k: "m", n: "Matin", h: "07h — 15h" },
  { k: "s", n: "Après-midi", h: "15h — 23h" },
  { k: "n", n: "Nuit", h: "23h — 07h" },
  { k: "r", n: "Repos", h: "—" },
];

// General shift : personnel de jour, hors rotation A / B / C (09h–17h, du lundi au samedi).
const GENERAL = { k: "G", n: "General shift", h: "09h — 17h", from: 9, to: 17, days: [1, 2, 3, 4, 5, 6] };
// Compte propriétaire de l'atelier : seul à voir le menu Accès.
const OWNER_USER_ID = 1;

/** Le General shift est-il en poste maintenant ? (heure du Bénin, UTC+1) */
// Postes sans messages ni appels (26/10/2026 : le Boss n'a accès ni aux messages ni aux appels).
const NO_CHAT_ROLES = ["forman"];
function canChat(user: { id?: number; jobRole?: string | null } | null | undefined): boolean {
  if (!user) return false;
  return user.id === OWNER_USER_ID || !NO_CHAT_ROLES.includes(user.jobRole ?? "");
}
function generalOnDuty(now: Date = new Date()): boolean {
  const local = new Date(now.getTime() + 3600000);
  const h = local.getUTCHours();
  return GENERAL.days.includes(local.getUTCDay()) && h >= GENERAL.from && h < GENERAL.to;
}

const M_STATUS: Record<string, { n: string; tone: "ok" | "warn" | "crit" }> = {
  service: { n: "En service", tone: "ok" },
  arret: { n: "À l'arrêt", tone: "crit" },
  maintenance: { n: "En maintenance", tone: "warn" },
};

const STOP_REASONS = [
  "Manque de mèche", "Manque de commande", "Changement d'article",
  "Manque de personnel", "Nettoyage", "Coupure électrique",
  "Arrêt programmé", "Pièce en attente", "Panne en cours", "Autre",
];

const COMMON_FAULTS = [
  "S26", "S27", "B120", "B121", "B91", "B124", "S123", "S124",
  "B707/706", "B709/710", "B712", "Side cute", "Belt broken",
  "Servodisc belt broken", "Main belt broken", "Bearing hot",
  "Drum separator jamming", "Jockey pulley missing", "Brake missing",
  "Link pulleys jamming", "Doffer height settings", "Ring rail height settings",
  "Doffer 161 height settings", "Doffer sensor height settings",
];

const GEAR_RANGE: Record<"G" | "H", [number, number]> = { G: [30, 65], H: [89, 113] };
const GEARS_PER_MACHINE = 6;
const STOCK_ALERT = 20;
const ACCESS_CODE = "G37";

// Draft total = 16,068 × H ÷ G (pignons de rechange G 30–65, H 89–113).
const DRAFT_K = 16.068;

function draftOf(g: number | null | undefined, h: number | null | undefined): number | null {
  if (!g || !h || g <= 0 || h <= 0) return null;
  return (DRAFT_K * h) / g;
}

function groupOf(no: number): GroupSpec {
  return GROUPS.find((g) => no >= g.from && no <= g.to) ?? GROUPS[0];
}

function cycleDays(kind: string, pointKey: string, machineNo: number): number {
  const o = CYCLE_OVERRIDES.find(
    (x) => x.kind === kind && x.point === pointKey && machineNo >= x.from && machineNo <= x.to,
  );
  if (o) return o.d;
  const defs = kind === "grease" ? GREASE_POINTS : LUB_BOXES;
  return defs.find((p) => p.k === pointKey)?.d ?? 30;
}

function inGearRange(type: "G" | "H", teeth: number | null | undefined): boolean {
  if (teeth == null || !Number.isInteger(teeth)) return false;
  const [lo, hi] = GEAR_RANGE[type];
  return teeth >= lo && teeth <= hi;
}

// Un admin de la plateforme a tous les droits. Un compte en attente n'en a aucun.
function can(
  perm: Perm,
  user: { role?: string | null; jobRole?: string | null; pending?: boolean | null } | null | undefined,
): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (user.pending) return false;
  const r = ROLES[user.jobRole ?? "helper"];
  return !!r && r.p.includes(perm);
}

// Null = le poste voit tout. Sinon, la liste exacte des onglets autorisés.
function visibleTabs(
  user: { role?: string | null; jobRole?: string | null } | null | undefined,
): string[] | null {
  if (!user) return [];
  if (user.role === "admin") return null;
  return ROLES[user.jobRole ?? "helper"]?.tabs ?? null;
}

export const g37 = {
  GROUPS, SPEC_LABELS, GREASE_POINTS, LUB_BOXES, CYCLE_OVERRIDES,
  ROLES, TEAMS, SHIFT_TYPES, GENERAL, OWNER_USER_ID, generalOnDuty, NO_CHAT_ROLES, canChat, M_STATUS, STOP_REASONS, COMMON_FAULTS,
  GEAR_RANGE, GEARS_PER_MACHINE, STOCK_ALERT, ACCESS_CODE, DRAFT_K,
  groupOf, cycleDays, inGearRange, draftOf, can, visibleTabs,
};
