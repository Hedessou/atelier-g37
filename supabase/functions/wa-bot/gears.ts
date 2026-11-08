// Pignons G/H : draft, stock disponible et propositions de couples (utilisés par les fiches et par l'assistant).
import { config, sql } from "./db.ts";

export const DRAFT_K = 16.068; // draft = 16,068 × H ÷ G (même formule que l'app)
// Pignons qui existent (lecture des fiches, modifications). H75–H88 ajoutés le 08/11/2026 (12 pièces chacun).
export const RANGE = { G: [30, 65], H: [75, 113] } as const;
/** Plus petit H que le robot a le droit de PROPOSER : 89 tant que l'admin n'a pas écrit « autoriser H75 » au robot (réglage gears.h_low_allowed). */
export async function proposeHMin(): Promise<number> {
  return /^(oui|yes|1|true)$/i.test(String(await config("gears.h_low_allowed")).trim()) ? RANGE.H[0] : 89;
}
export const PER_MACHINE = 6;
export const draftOf = (g: number, h: number) => (DRAFT_K * h) / g;
// Marge en % avec 2 décimales (« +0,01 % ») : au dixième, un écart de 0,04 % s'affichait « +0,0 % ».
export const pct = (x: number) => { const v = Math.round(x * 10000) / 100; return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2).replace(".", ",")} %`; };
export const fmt2 = (x: number) => x.toFixed(2);

export type Stock = Map<string, number>; // "G41" -> pièces disponibles (stock moins changements déjà en attente)
export async function availableStock(excludeMachines: number[]): Promise<Stock> {
  const [gears, pending] = await Promise.all([
    sql`SELECT gear_type, teeth, stock FROM gears`,
    sql`SELECT new_g, new_h FROM gear_change_requests WHERE status = 'pending' AND NOT (machine_no = ANY(${excludeMachines}))`,
  ]);
  const s: Stock = new Map(gears.map((r) => [`${r.gear_type}${r.teeth}`, Number(r.stock)]));
  for (const p of pending) {
    s.set(`G${p.new_g}`, (s.get(`G${p.new_g}`) ?? 0) - PER_MACHINE);
    s.set(`H${p.new_h}`, (s.get(`H${p.new_h}`) ?? 0) - PER_MACHINE);
  }
  return s;
}

// Autres couples G/H en stock qui donnent un draft proche (on garde si possible un des deux pignons de la fiche).
export function proposals(target: number, slip: { g: number | null; h: number | null }, stock: Stock, nMachines: number, hMin = 89) {
  const need = PER_MACHINE * nMachines;
  const out: Array<{ g: number; h: number; d: number; err: number; keeps: number }> = [];
  for (let g = RANGE.G[0]; g <= RANGE.G[1]; g++) {
    if ((stock.get(`G${g}`) ?? 0) < need) continue;
    for (let h = hMin; h <= RANGE.H[1]; h++) {
      if ((stock.get(`H${h}`) ?? 0) < need) continue;
      const d = draftOf(g, h);
      out.push({ g, h, d, err: (d - target) / target, keeps: (g === slip.g ? 1 : 0) + (h === slip.h ? 1 : 0) });
    }
  }
  // Le draft le plus juste d'abord ; garder un pignon de la fiche compte comme 0,3 % d'écart en moins.
  const score = (x: { err: number; keeps: number }) => Math.abs(x.err) - 0.003 * x.keeps;
  const close = out.filter((x) => Math.abs(x.err) <= 0.01).sort((a, b) => score(a) - score(b));
  return close.length ? { list: close.slice(0, 3), close: true } : { list: out.sort((a, b) => Math.abs(a.err) - Math.abs(b.err)).slice(0, 3), close: false };
}
