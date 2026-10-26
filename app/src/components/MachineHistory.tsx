import React, { useMemo, useState } from "react";
import type { OutputType as State } from "../endpoints/g37/state_GET.schema";
import { g37 } from "../helpers/g37";
import styles from "./MachineHistory.module.css";

// Fiche complète d'un métier : chiffres des 90 derniers jours et historique de tout ce qui lui est arrivé
// (pannes, maintenances avec check-list et photos, graissages, travaux, pièces sorties).

type Kind = "fault" | "maint" | "grease" | "work" | "part";
type Ev = { key: string; at: number; kind: Kind; title: string; sub: string; tone: "crit" | "ok" | "warn" | "info" | "dim"; photos?: string[]; extra?: string };

const H = 3600000;
const r1 = (v: number) => v.toFixed(1).replace(".", ",");
const money = (v: number) => Math.round(v).toLocaleString("fr-FR").replace(/ | /g, " ");

export function MachineHistory({ state, lang, no }: { state: State; lang: "fr" | "en"; no: number }) {
  const fr = lang === "fr";
  const t = (a: string, b: string) => (fr ? a : b);
  const [filter, setFilter] = useState<Kind | "all">("all");
  const [limit, setLimit] = useState(25);
  const [photo, setPhoto] = useState<string | null>(null);

  const pointName = (kind: string, key: string) => {
    const custom = (state.cyclePoints ?? []).find((p) => p.kind === kind && p.key === key);
    if (custom) return custom.name;
    const defs = kind === "grease" ? g37.GREASE_POINTS : g37.LUB_BOXES;
    return defs.find((p) => p.k === key)?.n ?? key;
  };

  const events = useMemo<Ev[]>(() => {
    const out: Ev[] = [];
    (state.failures ?? []).filter((f) => f.machineNo === no).forEach((f) => {
      const down = f.stoppedAt ? (new Date(f.restartedAt ?? f.resolvedAt ?? new Date()).getTime() - new Date(f.stoppedAt).getTime()) / H : 0;
      out.push({
        key: `f${f.id}`, at: new Date(f.openedAt).getTime(), kind: "fault", tone: f.status === "resolue" ? "warn" : "crit",
        title: f.issue,
        sub: [
          f.status === "resolue" ? `${t("réglée par", "fixed by")} ${f.fixedBy ?? "—"}` : t("ouverte", "open"),
          f.reportedBy ? `${t("signalée par", "reported by")} ${f.reportedBy}` : "",
          down > 0 ? `${t("arrêt", "stopped")} ${r1(down)} h` : "",
        ].filter(Boolean).join(" · "),
        extra: f.notes ?? undefined,
      });
    });
    const lists = new Map((state.checklists ?? []).filter((c) => c.machineNo === no).map((c) => [c.maintenanceId ?? c.id, c]));
    (state.maintenance ?? []).filter((r) => r.machineNo === no).forEach((r) => {
      const cl = lists.get(r.id);
      const done = cl ? cl.items.filter((i) => i.done).length : 0;
      out.push({
        key: `m${r.id}`, at: new Date(r.performedAt).getTime(), kind: "maint", tone: cl && done < cl.items.length ? "warn" : "ok",
        title: r.maintenanceType || t("Maintenance", "Maintenance"),
        sub: [r.technician ?? "", cl ? `${t("check-list", "checklist")} ${done}/${cl.items.length}` : ""].filter(Boolean).join(" · "),
        extra: cl ? [cl.items.filter((i) => !i.done).map((i) => `✗ ${i.text}`).join("\n"), cl.items.filter((i) => i.note).map((i) => `• ${i.text} : ${i.note}`).join("\n"), cl.notes ?? ""].filter(Boolean).join("\n") || undefined : (r.notes ?? undefined),
        photos: cl ? [cl.photoBeforeUrl, cl.photoAfterUrl].filter((u): u is string => !!u) : undefined,
      });
    });
    (state.greasing ?? []).filter((g) => g.machineNo === no).forEach((g, i) => {
      out.push({
        key: `g${i}-${g.kind}-${g.pointKey}-${String(g.doneOn)}`, at: new Date(g.doneOn).getTime() + 12 * H, kind: "grease", tone: "info",
        title: `${g.kind === "grease" ? t("Graissage", "Greasing") : g.kind === "lub" ? t("Lubrification", "Lubrication") : "Schedule works"} · ${pointName(g.kind, g.pointKey)}`,
        sub: g.authorName ?? "",
      });
    });
    (state.works ?? []).filter((w) => w.machineNo === no).forEach((w) => {
      out.push({
        key: `w${w.id}`, at: new Date(w.createdAt).getTime(), kind: "work", tone: w.status === "todo" ? "warn" : "dim",
        title: w.title, sub: [w.status === "todo" ? t("à faire", "to do") : w.doneByName ? `${t("fait par", "done by")} ${w.doneByName}` : (w.authorName ?? ""), w.auto ? t("pignons", "gears") : ""].filter(Boolean).join(" · "),
      });
    });
    (state.stockOuts ?? []).filter((o) => o.machineNo === no).forEach((o) => {
      out.push({
        key: `p${o.id}`, at: new Date(o.createdAt).getTime(), kind: "part", tone: "dim",
        title: `${o.itemName} × ${String(o.quantity).replace(".", ",")} ${o.unit}`,
        sub: [o.authorName ?? "", o.unitCost != null ? `${money(o.unitCost * o.quantity)} F` : ""].filter(Boolean).join(" · "),
        extra: o.reason ?? undefined,
      });
    });
    return out.sort((a, b) => b.at - a.at);
  }, [state, no, lang]);

  const since = Date.now() - 90 * 86400000;
  const recent = (state.failures ?? []).filter((f) => f.machineNo === no && new Date(f.openedAt).getTime() > since);
  const down90 = recent.reduce((a, f) => a + (f.stoppedAt ? Math.max(0, (new Date(f.restartedAt ?? f.resolvedAt ?? new Date()).getTime() - new Date(f.stoppedAt).getTime()) / H) : 0), 0);
  const reps = recent.filter((f) => f.resolvedAt).map((f) => (new Date(f.resolvedAt!).getTime() - new Date(f.openedAt).getTime()) / 60000);
  const mttr = reps.length ? reps.reduce((a, b) => a + b, 0) / reps.length : null;
  const parts = (state.stockOuts ?? []).filter((o) => o.machineNo === no && new Date(o.createdAt).getTime() > since);
  const partsCost = parts.reduce((a, o) => a + (o.unitCost == null ? 0 : o.unitCost * o.quantity), 0);
  const topIssue = (() => {
    const m = new Map<string, number>();
    recent.forEach((f) => m.set(f.issue, (m.get(f.issue) ?? 0) + 1));
    const top = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    return top && top[1] > 1 ? top : null;
  })();

  const shown = events.filter((e) => filter === "all" || e.kind === filter);
  const chips: Array<[Kind | "all", string]> = [
    ["all", t("Tout", "All")], ["fault", t("Pannes", "Faults")], ["maint", "Maintenance"], ["grease", t("Graissage", "Greasing")], ["work", t("Travaux", "Work")], ["part", t("Pièces", "Parts")],
  ];
  const dayLabel = (ms: number) => new Date(ms).toLocaleDateString(fr ? "fr-FR" : "en-GB", { day: "2-digit", month: "short", year: "numeric" });

  return (
    <section className={styles.card} aria-label={t("Fiche complète", "Full record")}>
      <div className={styles.head}>
        <h2 className={styles.h2}>{t("Fiche complète", "Full record")}</h2>
        <span className={styles.sub}>{t("90 derniers jours", "last 90 days")}</span>
      </div>
      <div className={styles.kpis}>
        <div className={styles.kpi}><span className={styles.kValue}>{recent.length}</span><span className={styles.kLabel}>{t("pannes", "faults")}</span></div>
        <div className={styles.kpi}><span className={styles.kValue}>{r1(down90)} h</span><span className={styles.kLabel}>{t("d'arrêt", "downtime")}</span></div>
        <div className={styles.kpi}><span className={styles.kValue}>{mttr == null ? "—" : `${Math.round(mttr)} min`}</span><span className={styles.kLabel}>{t("réparation moy.", "avg. repair")}</span></div>
        <div className={styles.kpi}><span className={styles.kValue}>{partsCost ? `${money(partsCost)} F` : parts.length}</span><span className={styles.kLabel}>{partsCost ? t("pièces", "parts") : t("pièces sorties", "parts used")}</span></div>
      </div>
      {topIssue && (
        <div className={styles.warn}>
          {t(`Panne répétée : « ${topIssue[0]} » ${topIssue[1]} fois en 90 jours. À traiter à la source.`, `Repeated fault: "${topIssue[0]}" ${topIssue[1]} times in 90 days. Fix the root cause.`)}
        </div>
      )}
      <div className={styles.chips} role="tablist" aria-label={t("Filtrer l'historique", "Filter history")}>
        {chips.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={filter === k} className={`${styles.chip} ${filter === k ? styles.chipOn : ""}`} onClick={() => { setFilter(k); setLimit(25); }}>
            {l}{k !== "all" ? ` ${events.filter((e) => e.kind === k).length}` : ""}
          </button>
        ))}
      </div>
      {shown.length ? (
        <ol className={styles.timeline}>
          {shown.slice(0, limit).map((e, i) => {
            const newDay = i === 0 || dayLabel(shown[i - 1].at) !== dayLabel(e.at);
            return (
              <React.Fragment key={e.key}>
                {newDay && <li className={styles.day} aria-hidden="true">{dayLabel(e.at)}</li>}
                <li className={styles.ev}>
                  <span className={`${styles.dot} ${styles[`tone_${e.tone}`]}`} />
                  <div className={styles.evBody}>
                    <div className={styles.evTitle}>{e.title}</div>
                    {e.sub && <div className={styles.evSub}>{e.sub}</div>}
                    {e.extra && <div className={styles.evExtra}>{e.extra}</div>}
                    {e.photos && e.photos.length > 0 && (
                      <div className={styles.photos}>
                        {e.photos.map((u, k) => (
                          <button key={u} type="button" className={styles.thumb} onClick={() => setPhoto(u)} aria-label={k === 0 ? t("Photo avant", "Photo before") : t("Photo après", "Photo after")}>
                            <img src={u} alt="" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              </React.Fragment>
            );
          })}
        </ol>
      ) : <p className={styles.empty}>{t("Rien d'enregistré pour l'instant.", "Nothing recorded yet.")}</p>}
      {shown.length > limit && (
        <button type="button" className={styles.more} onClick={() => setLimit((n) => n + 25)}>{t("Voir plus", "See more")} ({shown.length - limit})</button>
      )}
      {photo && (
        <button type="button" className={styles.viewer} onClick={() => setPhoto(null)} aria-label={t("Fermer la photo", "Close photo")}>
          <img src={photo} alt="" />
        </button>
      )}
    </section>
  );
}
