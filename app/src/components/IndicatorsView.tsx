import React, { useMemo, useState } from "react";
import { toast } from "sonner";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { OutputType as State, G37Failure } from "../endpoints/g37/state_GET.schema";
import { isOnline } from "../lib/net";
import { saveBlob } from "../lib/files";
import { Button } from "./Button";
import styles from "./IndicatorsView.module.css";

// Indicateurs des pannes d'un mois : nombre, arrêt, réparation moyenne, temps moyen entre deux pannes,
// métiers et causes les plus fréquents, pièces sorties. Export PDF (sur le téléphone) et Excel (serveur).

const H = 3600000;
const pad = (n: number) => String(n).padStart(2, "0");
const monthOf = (d: Date | string) => new Date(new Date(d).getTime() + H).toISOString().slice(0, 7);
const r1 = (v: number) => v.toFixed(1).replace(".", ",");
const money = (v: number) => Math.round(v).toLocaleString("fr-FR").replace(/ | /g, " ");

function down(f: G37Failure, until: Date) {
  if (!f.stoppedAt) return 0;
  return Math.max(0, (new Date(f.restartedAt ?? f.resolvedAt ?? until).getTime() - new Date(f.stoppedAt).getTime()) / H);
}

type Stats = {
  faults: G37Failure[]; open: number; downH: number; mttrMin: number | null; mtbfDays: number | null;
  byMachine: Array<{ no: number; n: number; down: number; cause: string }>;
  byCause: Array<{ issue: string; n: number; down: number }>;
  bySev: Record<string, number>;
  cost: number; priced: boolean; outs: number; topItems: Array<{ name: string; q: number; unit: string; cost: number }>;
  maint: number; checklistPct: number | null;
};

function compute(state: State, month: string): Stats {
  const now = new Date();
  const [y, m] = month.split("-").map(Number);
  const start = new Date(`${month}-01T00:00:00+01:00`);
  const end = new Date(`${m === 12 ? y + 1 : y}-${pad(m === 12 ? 1 : m + 1)}-01T00:00:00+01:00`);
  const until = end > now ? now : end;
  const periodH = Math.max(1, (until.getTime() - start.getTime()) / H);
  const nMachines = Math.max(1, state.machines.length);
  const faults = (state.failures ?? []).filter((f) => monthOf(f.openedAt) === month);
  const repairs = faults.filter((f) => f.resolvedAt).map((f) => (new Date(f.resolvedAt!).getTime() - new Date(f.openedAt).getTime()) / 60000).filter((v) => v >= 0);
  const mapM = new Map<number, { n: number; down: number; issues: Map<string, number> }>();
  const mapC = new Map<string, { n: number; down: number }>();
  const bySev: Record<string, number> = {};
  faults.forEach((f) => {
    const d = down(f, until);
    const e = mapM.get(f.machineNo) ?? { n: 0, down: 0, issues: new Map() };
    e.n++; e.down += d; e.issues.set(f.issue, (e.issues.get(f.issue) ?? 0) + 1);
    mapM.set(f.machineNo, e);
    const c = mapC.get(f.issue) ?? { n: 0, down: 0 };
    c.n++; c.down += d;
    mapC.set(f.issue, c);
    bySev[f.severity] = (bySev[f.severity] ?? 0) + 1;
  });
  const outs = (state.stockOuts ?? []).filter((o) => monthOf(o.createdAt) === month);
  const items = new Map<string, { name: string; q: number; unit: string; cost: number }>();
  outs.forEach((o) => {
    const e = items.get(o.itemId) ?? { name: o.itemName, q: 0, unit: o.unit, cost: 0 };
    e.q += o.quantity; e.cost += o.unitCost == null ? 0 : o.unitCost * o.quantity;
    items.set(o.itemId, e);
  });
  const lists = (state.checklists ?? []).filter((c) => monthOf(c.doneAt) === month);
  const steps = lists.reduce((a, c) => a + c.items.length, 0);
  const done = lists.reduce((a, c) => a + c.items.filter((i) => i.done).length, 0);
  return {
    faults, open: faults.filter((f) => f.status !== "resolue").length,
    downH: faults.reduce((a, f) => a + down(f, until), 0),
    mttrMin: repairs.length ? repairs.reduce((a, b) => a + b, 0) / repairs.length : null,
    mtbfDays: faults.length ? (periodH * nMachines) / faults.length / 24 : null,
    byMachine: [...mapM.entries()].map(([no, e]) => ({ no, n: e.n, down: e.down, cause: [...e.issues.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "" })).sort((a, b) => b.n - a.n || b.down - a.down),
    byCause: [...mapC.entries()].map(([issue, e]) => ({ issue, ...e })).sort((a, b) => b.n - a.n || b.down - a.down),
    bySev,
    cost: outs.reduce((a, o) => a + (o.unitCost == null ? 0 : o.unitCost * o.quantity), 0),
    priced: outs.some((o) => o.unitCost != null), outs: outs.length,
    topItems: [...items.values()].sort((a, b) => b.cost - a.cost || b.q - a.q).slice(0, 5),
    maint: (state.maintenance ?? []).filter((r) => monthOf(r.performedAt) === month).length,
    checklistPct: steps ? (done / steps) * 100 : null,
  };
}

export function IndicatorsView({ state, lang, onBack, onOpenMachine }: { state: State; lang: "fr" | "en"; onBack: () => void; onOpenMachine: (no: number) => void }) {
  const fr = lang === "fr";
  const t = (a: string, b: string) => (fr ? a : b);
  const months = useMemo(() => {
    const out: string[] = [];
    const now = new Date();
    for (let i = 0; i < 12; i++) out.push(monthOf(new Date(now.getFullYear(), now.getMonth() - i, 15)));
    return out;
  }, []);
  const [month, setMonth] = useState(months[0]);
  const prev = monthOf(new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 2, 15));
  const s = useMemo(() => compute(state, month), [state, month]);
  const p = useMemo(() => compute(state, prev), [state, prev]);
  const [busy, setBusy] = useState<"pdf" | "xlsx" | null>(null);
  const label = (mk: string) => new Date(Number(mk.slice(0, 4)), Number(mk.slice(5)) - 1, 15).toLocaleDateString(fr ? "fr-FR" : "en-GB", { month: "long", year: "numeric" });

  const delta = (now: number | null, before: number | null, lowerIsBetter: boolean, unit: string) => {
    if (now == null || before == null || (now === 0 && before === 0)) return null;
    const d = now - before;
    if (Math.abs(d) < 0.05) return <span className={styles.flat}>{t("stable", "steady")}</span>;
    const good = lowerIsBetter ? d < 0 : d > 0;
    return <span className={good ? styles.good : styles.bad}>{d > 0 ? "+" : "−"}{unit === "" ? Math.round(Math.abs(d)) : r1(Math.abs(d))}{unit} {t("vs mois préc.", "vs prev.")}</span>;
  };

  const excel = async () => {
    if (!isOnline()) { toast.error(t("Le fichier Excel est préparé par le serveur : il faut Internet.", "The Excel file is prepared by the server: Internet is needed.")); return; }
    setBusy("xlsx");
    try {
      const r = await fetch(`/_api/g37/report?month=${month}`);
      if (!r.ok) {
        let msg = t("Rapport impossible", "Report failed");
        try { const j = await r.json(); if (j?.error) msg = j.error; } catch { /* binaire */ }
        throw new Error(msg);
      }
      await saveBlob(await r.blob(), `rapport-pannes-G37-${month}.xlsx`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const pdf = async () => {
    setBusy("pdf");
    try {
      const doc = await PDFDocument.create();
      doc.setTitle(`Rapport des pannes G37 — ${month}`);
      const reg = await doc.embedFont(StandardFonts.Helvetica);
      const bold = await doc.embedFont(StandardFonts.HelveticaBold);
      const clean = (v: string) => v.replace(/→/g, "->").replace(/[−–—]/g, "-").replace(/[^\x00-\xFF]/g, "?");
      const W = 595.28, Hh = 841.89, L = 40, R = W - 40;
      let page = doc.addPage([W, Hh]);
      let y = Hh - 48;
      const need = (h: number) => { if (y - h < 56) { page = doc.addPage([W, Hh]); y = Hh - 48; } };
      const txt = (v: string, x: number, size = 9, f = reg, color = rgb(0.1, 0.12, 0.15)) => page.drawText(clean(v), { x, y, size, font: f, color });
      const rule = () => page.drawLine({ start: { x: L, y: y + 6 }, end: { x: R, y: y + 6 }, thickness: 0.5, color: rgb(0.8, 0.82, 0.86) });
      page.drawRectangle({ x: 0, y: Hh - 70, width: W, height: 70, color: rgb(0.06, 0.106, 0.176) });
      page.drawText(clean(`RAPPORT DES PANNES — ${label(month).toUpperCase()}`), { x: L, y: Hh - 40, size: 15, font: bold, color: rgb(1, 1, 1) });
      page.drawText(clean(`Atelier R/F · Rieter G37 · ${state.machines.length} métiers`), { x: L, y: Hh - 58, size: 9, font: reg, color: rgb(0.96, 0.62, 0.04) });
      y = Hh - 100;
      const kp: Array<[string, string]> = [
        ["Pannes signalées", String(s.faults.length)], ["Encore ouvertes", String(s.open)], ["Heures d'arrêt", `${r1(s.downH)} h`],
        ["Réparation moyenne", s.mttrMin == null ? "-" : `${Math.round(s.mttrMin)} min`], ["Entre deux pannes (par métier)", s.mtbfDays == null ? "-" : `${r1(s.mtbfDays)} jours`],
        ["Pièces sorties", s.priced ? `${money(s.cost)} F CFA` : `${s.outs} ${s.outs > 1 ? "sorties" : "sortie"}`], ["Maintenances faites", String(s.maint)],
        ["Check-lists complètes", s.checklistPct == null ? "-" : `${Math.round(s.checklistPct)} %`],
      ];
      kp.forEach(([k, v], i) => {
        const col = i % 2, x = L + col * 260;
        if (col === 0 && i > 0) y -= 18;
        txt(k, x, 9, reg, rgb(0.35, 0.4, 0.48));
        txt(v, x + 150, 10, bold);
      });
      y -= 34;
      const table = (title: string, heads: string[], xs: number[], rows: string[][]) => {
        need(50);
        txt(title, L, 11, bold); y -= 16; rule();
        heads.forEach((h, i) => txt(h, xs[i], 8, bold, rgb(0.35, 0.4, 0.48))); y -= 14;
        if (!rows.length) { txt("Aucune donnée.", L, 9); y -= 14; }
        rows.forEach((r) => { need(14); r.forEach((v, i) => txt(v.length > 48 ? v.slice(0, 47) + "…" : v, xs[i], 9)); y -= 14; });
        y -= 16;
      };
      table("Métiers les plus touchés", ["M/C", "Pannes", "Arrêt (h)", "Panne la plus fréquente"], [L, L + 60, L + 120, L + 200],
        s.byMachine.slice(0, 10).map((m) => [`M/C ${pad(m.no)}`, String(m.n), r1(m.down), m.cause]));
      table("Causes les plus fréquentes", ["Panne", "Nombre", "Arrêt (h)"], [L, L + 300, L + 370],
        s.byCause.slice(0, 10).map((c) => [c.issue, String(c.n), r1(c.down)]));
      table("Pièces les plus utilisées", ["Article", "Quantité", "Coût (F CFA)"], [L, L + 300, L + 390],
        s.topItems.map((i) => [i.name, `${r1(i.q).replace(",0", "")} ${i.unit}`, i.cost ? money(i.cost) : "-"]));
      table("Détail des pannes", ["Date", "M/C", "Panne", "Arrêt (h)", "Statut"], [L, L + 70, L + 115, L + 390, L + 450],
        s.faults.map((f) => [new Date(f.openedAt).toLocaleDateString("fr-FR"), pad(f.machineNo), f.issue, r1(down(f, new Date())), f.status === "resolue" ? "réglée" : "ouverte"]));
      doc.getPages().forEach((pg, i, all) => pg.drawText(clean(`Page ${i + 1}/${all.length} · généré le ${new Date().toLocaleDateString("fr-FR")}`), { x: L, y: 28, size: 7.5, font: reg, color: rgb(0.45, 0.5, 0.56) }));
      const bytes = await doc.save();
      await saveBlob(new Blob([bytes as BlobPart], { type: "application/pdf" }), `rapport-pannes-G37-${month}.pdf`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("PDF impossible", "PDF failed"));
    } finally {
      setBusy(null);
    }
  };

  const maxM = s.byMachine[0]?.n ?? 1;
  const maxC = s.byCause[0]?.n ?? 1;
  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <button type="button" className={styles.back} onClick={onBack} aria-label={t("Retour", "Back")}>‹</button>
        <div style={{ minWidth: 0 }}>
          <h1 className={styles.title}>{t("Indicateurs des pannes", "Fault indicators")}</h1>
          <p className={styles.sub}>{label(month)}</p>
        </div>
      </div>
      <div className={styles.months} role="tablist" aria-label={t("Mois", "Month")}>
        {months.map((mk) => (
          <button key={mk} type="button" role="tab" aria-selected={mk === month} className={`${styles.month} ${mk === month ? styles.monthOn : ""}`} onClick={() => setMonth(mk)}>
            {new Date(Number(mk.slice(0, 4)), Number(mk.slice(5)) - 1, 15).toLocaleDateString(fr ? "fr-FR" : "en-GB", { month: "short" })}
            {mk.slice(0, 4) !== months[0].slice(0, 4) ? ` ${mk.slice(2, 4)}` : ""}
          </button>
        ))}
      </div>

      <div className={styles.kpis}>
        <div className={styles.kpi}><span className={styles.kLabel}>{t("Pannes", "Faults")}</span><span className={styles.kValue}>{s.faults.length}</span>{delta(s.faults.length, p.faults.length, true, "")}</div>
        <div className={styles.kpi}><span className={styles.kLabel}>{t("Heures d'arrêt", "Downtime")}</span><span className={styles.kValue}>{r1(s.downH)} h</span>{delta(s.downH, p.downH, true, " h")}</div>
        <div className={styles.kpi}><span className={styles.kLabel}>{t("Réparation moyenne", "Avg. repair")}</span><span className={styles.kValue}>{s.mttrMin == null ? "—" : `${Math.round(s.mttrMin)} min`}</span>{delta(s.mttrMin, p.mttrMin, true, " min")}</div>
        <div className={styles.kpi}><span className={styles.kLabel}>{t("Entre deux pannes", "Between faults")}</span><span className={styles.kValue}>{s.mtbfDays == null ? "—" : `${r1(s.mtbfDays)} ${t("j", "d")}`}</span>{delta(s.mtbfDays, p.mtbfDays, false, ` ${t("j", "d")}`)}</div>
        <div className={styles.kpi}><span className={styles.kLabel}>{t("Pièces sorties", "Parts used")}</span><span className={styles.kValue}>{s.priced ? `${money(s.cost)} F` : String(s.outs)}</span><span className={styles.flat}>{s.outs} {s.outs > 1 ? t("sorties", "items") : t("sortie", "item")}</span></div>
        <div className={styles.kpi}><span className={styles.kLabel}>{t("Check-lists complètes", "Complete checklists")}</span><span className={styles.kValue}>{s.checklistPct == null ? "—" : `${Math.round(s.checklistPct)} %`}</span><span className={styles.flat}>{s.maint} {s.maint > 1 ? t("maintenances", "maintenances") : t("maintenance", "maintenance")}</span></div>
      </div>

      <section className={styles.card}>
        <h2 className={styles.h2}>{t("Métiers les plus touchés", "Most affected machines")}</h2>
        {s.byMachine.length ? s.byMachine.slice(0, 5).map((m) => (
          <button key={m.no} type="button" className={styles.barRow} onClick={() => onOpenMachine(m.no)}>
            <span className={styles.barTop}><span><strong className={styles.mono}>M/C {pad(m.no)}</strong> · {m.cause}</span><span className={styles.mono}>{m.n} {m.n > 1 ? t("pannes", "faults") : t("panne", "fault")} · {r1(m.down)} h</span></span>
            <span className={styles.track}><span className={styles.fill} style={{ width: `${(m.n / maxM) * 100}%` }} /></span>
          </button>
        )) : <p className={styles.empty}>{t("Aucune panne ce mois-ci.", "No fault this month.")}</p>}
      </section>

      <section className={styles.card}>
        <h2 className={styles.h2}>{t("Causes les plus fréquentes", "Most frequent causes")}</h2>
        {s.byCause.length ? s.byCause.slice(0, 6).map((c) => (
          <div key={c.issue} className={styles.barRow}>
            <span className={styles.barTop}><span>{c.issue}</span><span className={styles.mono}>{c.n}× · {r1(c.down)} h</span></span>
            <span className={styles.track}><span className={styles.fill} style={{ width: `${(c.n / maxC) * 100}%`, background: "#60a5fa" }} /></span>
          </div>
        )) : <p className={styles.empty}>—</p>}
        {s.faults.length > 0 && (
          <div className={styles.sev}>
            {[["haute", t("Haute", "High"), "#f87171"], ["moyenne", t("Moyenne", "Medium"), "#fbbf24"], ["basse", t("Basse", "Low"), "#34d399"]].map(([k, l, c]) => (
              <span key={k} className={styles.sevItem}><span className={styles.dot} style={{ background: c }} />{l} : <strong className={styles.mono}>{s.bySev[k] ?? 0}</strong></span>
            ))}
          </div>
        )}
      </section>

      {s.topItems.length > 0 && (
        <section className={styles.card}>
          <h2 className={styles.h2}>{t("Pièces les plus utilisées", "Most used parts")}</h2>
          {s.topItems.map((i) => (
            <div key={i.name} className={styles.line}><span>{i.name}</span><span className={styles.mono}>{r1(i.q).replace(",0", "")} {i.unit}{i.cost ? ` · ${money(i.cost)} F` : ""}</span></div>
          ))}
        </section>
      )}

      <div className={styles.exports}>
        <Button size="lg" onClick={() => void pdf()} disabled={busy !== null}>{busy === "pdf" ? t("Préparation…", "Preparing…") : t("Rapport PDF", "PDF report")}</Button>
        <Button size="lg" variant="outline" onClick={() => void excel()} disabled={busy !== null}>{busy === "xlsx" ? t("Préparation…", "Preparing…") : t("Fichier Excel", "Excel file")}</Button>
      </div>
      <p className={styles.note}>{t("Le PDF se fait sur le téléphone, même sans Internet. Le fichier Excel (détail complet) est préparé par le serveur.", "The PDF is made on the phone, even offline. The Excel file (full detail) is prepared by the server.")}</p>
    </div>
  );
}
