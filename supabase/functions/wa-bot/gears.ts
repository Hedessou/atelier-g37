// Pignons G/H : draft, stock disponible et propositions de couples (utilisés par les fiches et par l'assistant).
import { sql } from "./db.ts";

export const DRAFT_K = 16.068; // draft = 16,068 × H ÷ G (même formule que l'app)
export const RANGE = { G: [30, 65], H: [89, 113] } as const;
export const PER_MACHINE = 6;
export const draftOf = (g: number, h: number) => (DRAFT_K * h) / g;
export const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1).replace(".", ",")} %`;
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
export function proposals(target: number, slip: { g: number | null; h: number | null }, stock: Stock, nMachines: number) {
  const need = PER_MACHINE * nMachines;
  const out: Array<{ g: number; h: number; d: number; err: number; keeps: number }> = [];
  for (let g = RANGE.G[0]; g <= RANGE.G[1]; g++) {
    if ((stock.get(`G${g}`) ?? 0) < need) continue;
    for (let h = RANGE.H[0]; h <= RANGE.H[1]; h++) {
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
