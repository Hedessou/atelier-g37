import React, { useEffect, useMemo, useState } from "react";
import type { OutputType as State } from "../endpoints/g37/state_GET.schema";
import type { InputType } from "../endpoints/g37/mutate_POST.schema";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./Dialog";
import styles from "./MaintScheduleDialog.module.css";

// Le superviseur programme, la veille, les métiers qui passent en maintenance (27/10/2026).
// Les métiers dont la maintenance est due (ou en retard) à cette date sont proposés d'office.

const H = 3600000;
const D = 86400000;
const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (t: number) => new Date(t + H).toISOString().slice(0, 10);

export function MaintScheduleDialog({ open, onOpenChange, state, lang, save }: {
  open: boolean; onOpenChange: (o: boolean) => void; state: State; lang: "fr" | "en"; save: (input: InputType) => void;
}) {
  const fr = lang === "fr";
  const t = (a: string, b: string) => (fr ? a : b);
  const tomorrow = localDay(Date.now() + D);
  const after = localDay(Date.now() + 2 * D);
  const [day, setDay] = useState(tomorrow);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [note, setNote] = useState("");

  const dueOn = (d: string) => state.machines.filter((m) => m.nextMaintenance && new Date(m.nextMaintenance).toISOString().slice(0, 10) <= d).map((m) => m.no);
  const plannedOn = (d: string) => state.machines.filter((m) => m.plannedBy && m.nextMaintenance && new Date(m.nextMaintenance).toISOString().slice(0, 10) === d).map((m) => m.no);

  // À l'ouverture et au changement de date : ce qui est déjà programmé ce jour-là.
  useEffect(() => {
    if (!open) return;
    setPicked(new Set(plannedOn(day)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, day]);
  useEffect(() => { if (open) { setDay(tomorrow); setNote(""); } }, [open, tomorrow]);

  const due = useMemo(() => new Set(dueOn(day)), [state.machines, day]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (no: number) => setPicked((s) => { const n = new Set(s); if (n.has(no)) n.delete(no); else n.add(no); return n; });
  const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(fr ? "fr-FR" : "en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const list = [...picked].sort((a, b) => a - b);

  const submit = () => {
    if (!list.length) return;
    save({ action: "maintSchedule", machines: list, day, note: note.trim() || null });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={styles.dialog}>
        <DialogHeader>
          <DialogTitle>{t("Programmer la maintenance", "Schedule maintenance")}</DialogTitle>
        </DialogHeader>

        <div className={styles.days}>
          <button type="button" className={day === tomorrow ? styles.dayOn : styles.day} onClick={() => setDay(tomorrow)}>
            <strong>{t("Demain", "Tomorrow")}</strong><span>{dayLabel(tomorrow)}</span>
          </button>
          <button type="button" className={day === after ? styles.dayOn : styles.day} onClick={() => setDay(after)}>
            <strong>{t("Après-demain", "Day after")}</strong><span>{dayLabel(after)}</span>
          </button>
          <label className={day !== tomorrow && day !== after ? styles.dayOn : styles.day}>
            <strong>{t("Autre jour", "Other day")}</strong>
            <input type="date" value={day} min={localDay(Date.now())} onChange={(e) => e.target.value && setDay(e.target.value)} />
          </label>
        </div>

        <div className={styles.barRow}>
          <span className={styles.hint}>{t("Touche les métiers à arrêter pour la maintenance.", "Tap the machines to stop for maintenance.")}</span>
          {due.size > 0 && (
            <button type="button" className={styles.dueBtn} onClick={() => setPicked((s) => new Set([...s, ...due]))}>
              {t(`+ Les ${due.size} dus`, `+ The ${due.size} due`)}
            </button>
          )}
        </div>

        <div className={styles.grid}>
          {state.machines.map((m) => {
            const on = picked.has(m.no);
            const isDue = due.has(m.no);
            return (
              <button key={m.no} type="button" aria-pressed={on} onClick={() => toggle(m.no)}
                className={`${styles.mc} ${on ? styles.mcOn : ""} ${m.status === "arret" ? styles.mcStop : m.status === "maintenance" ? styles.mcMaint : ""}`}>
                <span className={styles.mcNo}>{pad(m.no)}</span>
                {isDue && <span className={styles.dueDot} title={t("Maintenance due", "Maintenance due")} />}
                {on && <span className={styles.tick}>✓</span>}
              </button>
            );
          })}
        </div>
        <div className={styles.legend}>
          <span><i className={styles.lDue} /> {t("maintenance due à cette date", "maintenance due by then")}</span>
          <span><i className={styles.lStop} /> {t("à l'arrêt", "stopped")}</span>
        </div>

        <textarea className={styles.note} rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder={t("Consigne pour l'équipe (facultatif) : ex. commencer par la M/C 7", "Note for the team (optional)")} />

        <button type="button" className={styles.go} disabled={!list.length} onClick={submit}>
          {list.length
            ? t(`Programmer ${list.length} métier${list.length > 1 ? "s" : ""} — ${dayLabel(day)}`, `Schedule ${list.length} machine${list.length > 1 ? "s" : ""} — ${dayLabel(day)}`)
            : t("Choisis au moins un métier", "Pick at least one machine")}
        </button>
        <p className={styles.foot}>{t("Les techniciens sont prévenus tout de suite. Les métiers apparaissent dans « Maintenance programmée » à l'accueil.", "Technicians are notified right away. Machines show under “Scheduled maintenance” on the home screen.")}</p>
      </DialogContent>
    </Dialog>
  );
}
