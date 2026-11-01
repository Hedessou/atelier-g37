// Modifications de l'app demandées sur WhatsApp (01/11/2026).
// L'IA comprend la demande et la décrit avec des « intentions » simples ; ici on les transforme en vraies opérations
// de l'app (mêmes actions que les boutons), avec un résumé clair que la personne confirme par « oui ».
// Rien n'est appliqué ici : l'application se fait par le serveur de l'app, avec les droits du compte de la personne.
import { beninDay, ddmm, isoDay, rf, sql } from "./db.ts";
import { allPoints, findItems } from "./features.ts";
import { canEditType, type Level } from "./people.ts";
import { RANGE } from "./gears.ts";

export type Intent = {
  type: string; machines?: number[] | null; g?: number | null; h?: number | null; count?: number | null; date?: string | null;
  item?: string | null; qty?: number | null; mode?: string | null; gear?: string | null; team?: string | null; shift?: string | null;
  person?: string | null; role?: string | null; approve?: boolean | null; status?: string | null; reason?: string | null; text?: string | null;
};
export type Built = { ops: Record<string, unknown>[]; lines: string[]; problems: string[] };

// Schéma donné à l'IA (champ « edits » de sa réponse).
export const EDITS_SCHEMA = {
  type: "ARRAY", nullable: true,
  items: {
    type: "OBJECT",
    properties: {
      type: { type: "STRING", enum: ["gears", "count", "maint_next", "maint_done", "maint_schedule", "machine_status", "stock_in", "stock_out", "stock_set",
        "gear_stock", "shift", "access", "work_add", "work_done", "fault_add", "fault_fix", "greasing"] },
      machines: { type: "ARRAY", items: { type: "INTEGER" }, nullable: true },
      g: { type: "INTEGER", nullable: true }, h: { type: "INTEGER", nullable: true },
      count: { type: "NUMBER", nullable: true },
      date: { type: "STRING", nullable: true },
      item: { type: "STRING", nullable: true }, qty: { type: "NUMBER", nullable: true },
      mode: { type: "STRING", enum: ["set", "add", "remove"], nullable: true },
      gear: { type: "STRING", nullable: true },
      team: { type: "STRING", enum: ["A", "B", "C", "G"], nullable: true },
      shift: { type: "STRING", enum: ["m", "s", "n", "r"], nullable: true },
      person: { type: "STRING", nullable: true }, role: { type: "STRING", nullable: true }, approve: { type: "BOOLEAN", nullable: true },
      status: { type: "STRING", enum: ["service", "arret", "maintenance"], nullable: true },
      reason: { type: "STRING", nullable: true }, text: { type: "STRING", nullable: true },
    },
    required: ["type"],
  },
};

// Consigne ajoutée à celle de l'assistant.
export const EDITS_HELP = `Modifications (champ "edits") : seulement si MODIFICATIONS AUTORISÉES = oui ET que la personne DEMANDE de changer quelque chose dans G37
(« mets G43 sur la Mc 12 », « change le count de la 5 en 60 », « décale la maintenance de la Mc 3 au 05/11 », « ajoute 4 belt 1600 au magasin »,
« équipe B de nuit demain », « valide le compte de Brice », « passe Eric technicien »). Une entrée par changement :
- gears : machines, g et/ou h (dents). count : machines, count (nombre : « 60 CCW » → 60).
- maint_next : machines, date (AAAA-MM-JJ) = prochaine maintenance. maint_done : machines (maintenance faite aujourd'hui, prochaine dans 30 j).
- maint_schedule : machines, date (programmer la maintenance ce jour-là).
- machine_status : machines, status (service / arret / maintenance), reason (motif de l'arrêt).
- stock_in / stock_out : item (nom de l'article), qty, machines (pour une sortie, si dite). stock_set : item, qty (inventaire : quantité exacte).
- gear_stock : gear (« G41 », « H104 »), qty, mode (set = quantité exacte, add = arrivée, remove = sortie).
- shift : date, team (A/B/C), shift (m = matin, s = après-midi, n = nuit, r = repos).
- access : person (nom dans l'app), role (admin, superviseur, technicien, shift, genmaint, greaser, manager, forman, prodsup, prodman, helper) et/ou team, approve (true = valider le compte, false = le bloquer).
- greasing : item (point de graissage / lubrification : « front rollers », « nipples », « drafting gear box »…), machines (graissage fait aujourd'hui).
- work_add : machines, text. work_done : machines, text (quel travail). fault_add : machines, text. fault_fix : machines, text (ce qui a été fait).
Dates relatives (« demain », « lundi ») : calcule-les depuis la date d'aujourd'hui donnée plus haut. Ne mets que ce que la personne a demandé.
Dans "reply", ne dis pas que c'est fait : le système résume et demande « oui » avant de modifier.`;

const JOBS: Record<string, string> = { admin: "Admin", superviseur: "Superviseur", technicien: "Technicien", shift: "Shift technician", genmaint: "Resp. maintenance générale",
  greaser: "Opérateur graissage", manager: "Manager", forman: "Boss", prodsup: "Prod superviseur", prodman: "Prod manager", helper: "Helper" };
const SHIFTS: Record<string, string> = { m: "matin (07h–15h)", s: "après-midi (15h–23h)", n: "nuit (23h–07h)", r: "repos" };
const STATUS: Record<string, string> = { service: "en service", arret: "à l'arrêt", maintenance: "en maintenance" };
const machineId = (n: number) => "M-" + String(n).padStart(2, "0");
const validDay = (d: unknown) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + "T00:00:00Z").getTime());
const ddmmyy = (d: string) => `${ddmm(d)}/${d.slice(2, 4)}`;
const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();

async function findUser(name: string) {
  const rows = await sql`SELECT id, display_name, job_role, team, pending FROM users ORDER BY id`;
  const q = norm(name);
  if (!q) return { best: null, list: [] as typeof rows };
  const exact = rows.filter((r) => norm(String(r.display_name)) === q);
  if (exact.length === 1) return { best: exact[0], list: exact };
  const words = q.split(" ");
  const part = rows.filter((r) => { const n = norm(String(r.display_name)); return words.every((w) => n.includes(w)); });
  return { best: part.length === 1 ? part[0] : null, list: part };
}

const TYPE_FR: Record<string, string> = { gears: "pignons", count: "count", maint_next: "dates de maintenance", maint_done: "fin de maintenance",
  maint_schedule: "programmation de maintenance", machine_status: "état des machines", stock_in: "arrivées au magasin", stock_out: "sorties de matériel",
  stock_set: "inventaire du magasin", gear_stock: "stock de pignons", shift: "quarts", access: "accès", work_add: "travaux", work_done: "travaux",
  fault_add: "pannes", fault_fix: "pannes", greasing: "graissage" };

export async function buildEdits(intents: Intent[], level: Level = "owner"): Promise<Built> {
  const ops: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const problems: string[] = [];
  const machineRows = new Map<number, Record<string, unknown>>();
  const machine = async (n: number) => {
    if (!machineRows.has(n)) {
      const [m] = await sql`SELECT machine_no, run_g, run_h, run_count, status, stop_reason, stopped_since, next_maintenance FROM machines WHERE machine_no = ${n}`;
      if (m) machineRows.set(n, m as Record<string, unknown>);
    }
    return machineRows.get(n) ?? null;
  };
  const nums = (it: Intent) => [...new Set((it.machines ?? []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 28))];

  for (const it of (intents ?? []).slice(0, 20)) {
    const list = nums(it);
    if (!canEditType(level, it.type)) { problems.push(`Tu n'as pas le droit de modifier ${TYPE_FR[it.type] ?? it.type} depuis WhatsApp.`); continue; }
    switch (it.type) {
      case "gears":
      case "machine_status": {
        if (!list.length) { problems.push("Numéro de machine manquant."); break; }
        for (const n of list) {
          const m = await machine(n);
          if (!m) { problems.push(`${rf(n)} inconnue.`); continue; }
          // Une seule opération « machine » par métier : on part de la dernière préparée.
          const prev = ops.findLast((o) => o.action === "machine" && o.no === n) as Record<string, unknown> | undefined;
          const base = prev ?? { action: "machine", no: n, runG: m.run_g ?? null, runH: m.run_h ?? null, status: m.status ?? "service",
            stopReason: m.stop_reason ?? null, stoppedSince: m.stopped_since ? new Date(String(m.stopped_since)).toISOString() : null };
          if (it.type === "gears") {
            const g = it.g ?? null, h = it.h ?? null;
            if (g == null && h == null) { problems.push(`${rf(n)} : quelles dents (G ou H) ?`); continue; }
            if (g != null && (g < RANGE.G[0] || g > RANGE.G[1])) { problems.push(`G${g} hors plage (G ${RANGE.G[0]}–${RANGE.G[1]}).`); continue; }
            if (h != null && (h < RANGE.H[0] || h > RANGE.H[1])) { problems.push(`H${h} hors plage (H ${RANGE.H[0]}–${RANGE.H[1]}).`); continue; }
            if (g != null) base.runG = g;
            if (h != null) base.runH = h;
            lines.push(`${rf(n)} : pignons G${m.run_g ?? "?"} → *G${base.runG ?? "?"}*, H${m.run_h ?? "?"} → *H${base.runH ?? "?"}* (stock des pignons mis à jour)`);
          } else {
            const st = String(it.status ?? "");
            if (!STATUS[st]) { problems.push(`${rf(n)} : état inconnu.`); continue; }
            base.status = st;
            base.stopReason = st === "service" ? null : (it.reason?.trim().slice(0, 120) || (st === "maintenance" ? "Nettoyage" : "Autre"));
            base.stoppedSince = st === "service" ? null : (m.status === st && m.stopped_since ? new Date(String(m.stopped_since)).toISOString() : new Date().toISOString());
            lines.push(`${rf(n)} : *${STATUS[st]}*${base.stopReason ? ` (${base.stopReason})` : ""}`);
          }
          if (!prev) ops.push(base);
        }
        break;
      }
      case "count": {
        const c = Number(it.count);
        if (!list.length || !(c > 0 && c <= 500)) { problems.push("Count : machine ou valeur manquante."); break; }
        for (const n of list) {
          const m = await machine(n);
          if (!m) { problems.push(`${rf(n)} inconnue.`); continue; }
          ops.push({ action: "machineCount", no: n, count: c });
          lines.push(`${rf(n)} : count ${m.run_count != null ? Number(m.run_count) : "?"} → *${c}*`);
        }
        break;
      }
      case "maint_next": {
        if (!list.length || !validDay(it.date)) { problems.push("Date de maintenance : machine ou date manquante."); break; }
        for (const n of list) {
          const m = await machine(n);
          if (!m) { problems.push(`${rf(n)} inconnue.`); continue; }
          ops.push({ action: "maintPlan", machineNo: n, next: `${it.date}T00:00:00.000Z` });
          lines.push(`${rf(n)} : prochaine maintenance ${m.next_maintenance ? ddmmyy(isoDay(String(m.next_maintenance))) : "?"} → *${ddmmyy(it.date!)}*`);
        }
        break;
      }
      case "maint_done": {
        if (!list.length) { problems.push("Maintenance faite : numéro de machine manquant."); break; }
        const next = new Date(new Date(beninDay() + "T00:00:00Z").getTime() + 30 * 86400000).toISOString().slice(0, 10);
        for (const n of list) {
          ops.push({ action: "maintDone", machineNo: n });
          lines.push(`${rf(n)} : *maintenance faite* aujourd'hui, prochaine le ${ddmmyy(next)}`);
        }
        break;
      }
      case "maint_schedule": {
        if (!list.length || !validDay(it.date)) { problems.push("Programmer la maintenance : machines ou date manquantes."); break; }
        ops.push({ action: "maintSchedule", machines: list, day: it.date, note: it.text?.trim().slice(0, 300) || null });
        lines.push(`Maintenance *programmée le ${ddmmyy(it.date!)}* : ${list.map(rf).join(", ")} (les techniciens sont prévenus)`);
        break;
      }
      case "stock_in":
      case "stock_out":
      case "stock_set": {
        const q = Number(it.qty);
        if (!it.item?.trim() || !(q >= 0) || (it.type !== "stock_set" && q <= 0)) { problems.push("Magasin : article ou quantité manquant."); break; }
        const { best, candidates } = await findItems(it.item);
        if (!best) {
          problems.push(candidates.length ? `Magasin : plusieurs articles possibles pour « ${it.item} » : ${candidates.map((c) => c.name).join(" ; ")}. Précise le nom.`
            : `Magasin : aucun article ne ressemble à « ${it.item} ».`);
          break;
        }
        if (it.type === "stock_in") {
          ops.push({ action: "stockIn", itemId: best.id, quantity: q, note: "Arrivée enregistrée via le robot WhatsApp" });
          lines.push(`Magasin : *+${q} ${best.unit}* ${best.name} (${best.quantity} → ${best.quantity + q})`);
        } else if (it.type === "stock_out") {
          const n = list[0] ?? null;
          ops.push({ action: "stockOut", itemId: best.id, quantity: q, machineNo: n, note: `Sortie via le robot WhatsApp${n ? ` pour la Mc ${n}` : ""}` });
          lines.push(`Magasin : *−${q} ${best.unit}* ${best.name}${n ? ` pour la ${rf(n)}` : ""} (${best.quantity} → ${Math.max(0, best.quantity - q)})`);
        } else {
          ops.push({ action: "stockQty", id: best.id, quantity: q });
          lines.push(`Magasin : inventaire ${best.name} ${best.quantity} → *${q} ${best.unit}*`);
        }
        break;
      }
      case "gear_stock": {
        const g = String(it.gear ?? "").toUpperCase().match(/^([GH])\s*-?\s*(\d{2,3})$/);
        const q = Number(it.qty);
        if (!g || !(q >= 0)) { problems.push("Stock de pignons : pignon (ex. G41) ou quantité manquant."); break; }
        const type = g[1] as "G" | "H", teeth = Number(g[2]);
        const [row] = await sql`SELECT stock FROM gears WHERE gear_type = ${type} AND teeth = ${teeth}`;
        if (!row) { problems.push(`Pignon ${type}${teeth} inconnu.`); break; }
        const cur = Number(row.stock);
        const mode = it.mode === "add" ? "add" : it.mode === "remove" ? "remove" : "set";
        const target = mode === "add" ? cur + q : mode === "remove" ? Math.max(0, cur - q) : q;
        // baseStock = stock lu maintenant : si quelqu'un modifie entre-temps, seul l'écart est appliqué (comme l'app hors ligne).
        ops.push({ action: "gearStock", gearType: type, teeth, stock: target, baseStock: cur });
        lines.push(`Pignons ${type}${teeth} : ${cur} → *${target}* pièce(s)`);
        break;
      }
      case "shift": {
        const team = String(it.team ?? "");
        const code = String(it.shift ?? "");
        if (!validDay(it.date) || !["A", "B", "C"].includes(team) || !SHIFTS[code]) { problems.push("Quart : date, équipe (A/B/C) ou quart manquant."); break; }
        const [cur] = await sql`SELECT shift_code FROM shift_plan WHERE day = ${it.date}::date AND team = ${team}`;
        ops.push({ action: "shiftSet", day: it.date, team, shiftCode: code });
        lines.push(`Quarts : équipe ${team} le ${ddmmyy(it.date!)} : ${cur ? SHIFTS[String(cur.shift_code)] ?? cur.shift_code : "rien"} → *${SHIFTS[code]}*`);
        break;
      }
      case "access": {
        if (!it.person?.trim()) { problems.push("Accès : de quelle personne s'agit-il ?"); break; }
        const { best, list: found } = await findUser(it.person);
        if (!best) {
          problems.push(found.length ? `Accès : plusieurs comptes pour « ${it.person} » : ${found.slice(0, 5).map((u) => u.display_name).join(" ; ")}.` : `Accès : aucun compte « ${it.person} » dans l'app.`);
          break;
        }
        const role = it.role ? String(it.role).toLowerCase() : String(best.job_role ?? "helper");
        if (!JOBS[role]) { problems.push(`Accès : poste « ${it.role} » inconnu (${Object.keys(JOBS).join(", ")}).`); break; }
        const team = it.team ?? (best.team as string | null) ?? null;
        const pending = it.approve == null ? !!best.pending : !it.approve;
        ops.push({ action: "grade", userId: Number(best.id), jobRole: role, team, pending });
        const what: string[] = [];
        if (role !== best.job_role) what.push(`poste ${JOBS[String(best.job_role)] ?? best.job_role} → *${JOBS[role]}*`);
        if (team !== best.team) what.push(`équipe ${best.team ?? "—"} → *${team ?? "—"}*`);
        if (pending !== !!best.pending) what.push(pending ? "*compte bloqué* (en attente)" : "*compte validé*");
        lines.push(`Accès de ${String(best.display_name).trim()} : ${what.join(", ") || "aucun changement"}`);
        break;
      }
      case "work_add": {
        if (!list.length || !it.text?.trim()) { problems.push("Travail : machine ou description manquante."); break; }
        for (const n of list) {
          ops.push({ action: "workAdd", machineNo: n, title: it.text.trim().slice(0, 300), status: "todo" });
          lines.push(`${rf(n)} : travail à effectuer « ${it.text.trim().slice(0, 80)} »`);
        }
        break;
      }
      case "work_done": {
        if (!list.length) { problems.push("Travail fait : numéro de machine manquant."); break; }
        for (const n of list) {
          const works = await sql`SELECT id, title FROM works WHERE machine_no = ${n} AND status = 'todo' ORDER BY created_at`;
          const words = norm(it.text ?? "").split(" ").filter((w) => w.length > 2);
          const match = words.length ? works.filter((w) => words.some((x) => norm(String(w.title)).includes(x))) : works;
          if (match.length !== 1) {
            problems.push(works.length ? `${rf(n)} : quel travail ? ${works.map((w) => `« ${w.title} »`).join(" ; ")}` : `${rf(n)} : aucun travail en attente.`);
            continue;
          }
          ops.push({ action: "workDone", id: match[0].id });
          lines.push(`${rf(n)} : travail *fait* « ${String(match[0].title).slice(0, 80)} »`);
        }
        break;
      }
      case "fault_add": {
        if (!list.length || !it.text?.trim()) { problems.push("Panne : machine ou description manquante."); break; }
        for (const n of list) {
          ops.push({ action: "faultAdd", machineNo: n, issue: it.text.trim().slice(0, 300), notes: "Signalée via le robot WhatsApp", severity: "moyenne", stoppedAt: null });
          lines.push(`${rf(n)} : nouvelle panne « ${it.text.trim().slice(0, 80)} »`);
        }
        break;
      }
      case "fault_fix": {
        if (!list.length) { problems.push("Panne réglée : numéro de machine manquant."); break; }
        for (const n of list) {
          const open = await sql`SELECT id, issue FROM failures WHERE machine_id = ${machineId(n)} AND status <> 'resolue' ORDER BY opened_at`;
          if (!open.length) { problems.push(`${rf(n)} : aucune panne ouverte.`); continue; }
          for (const f of open) {
            ops.push({ action: "faultFix", id: f.id, fix: it.text?.trim().slice(0, 2000) || null, restartedAt: new Date().toISOString() });
            lines.push(`${rf(n)} : panne « ${String(f.issue).slice(0, 60)} » *réglée*${it.text ? ` (${it.text.trim().slice(0, 60)})` : ""}`);
          }
        }
        break;
      }
      case "greasing": {
        if (!list.length || !it.item?.trim()) { problems.push("Graissage : point (ex. front rollers) ou machines manquants."); break; }
        const q = norm(it.item);
        const points = await allPoints();
        const pt = points.find((p) => p.aliases.some((a) => norm(a) === q)) ?? points.find((p) => p.aliases.some((a) => q.includes(norm(a)) || norm(a).includes(q)));
        if (!pt) { problems.push(`Graissage : point « ${it.item} » inconnu (${points.slice(0, 6).map((p) => p.name).join(", ")}…).`); break; }
        // Machines consécutives regroupées : « 1 à 8 » = une seule opération.
        const sorted = [...list].sort((a, b) => a - b);
        for (let i = 0; i < sorted.length; i++) {
          let j = i;
          while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
          ops.push({ action: "cycle", kind: pt.kind, pointKey: pt.key, from: sorted[i], to: sorted[j] });
          i = j;
        }
        lines.push(`${pt.kind === "lub" ? "Lubrification" : pt.kind === "sched" ? "Schedule works" : "Graissage"} *${pt.name}* fait aujourd'hui : ${sorted.map(rf).join(", ")}`);
        break;
      }
      default:
        problems.push(`Modification « ${it.type} » non prise en charge.`);
    }
  }
  return { ops, lines, problems };
}
