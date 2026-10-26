import React, { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { OutputType as State } from "../endpoints/g37/state_GET.schema";
import type { InputType } from "../endpoints/g37/mutate_POST.schema";
import { postG37Upload } from "../endpoints/g37/upload_POST.schema";
import { isOnline } from "../lib/net";
import { Button } from "./Button";
import { Input } from "./Input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./Dialog";
import styles from "./Checklist.module.css";

// Check-list de la maintenance (« maintenance clg ») :
// - le modèle (étapes de départ tirées du manuel G37) se modifie par l'admin, le superviseur, le manager et le Boss ;
// - pendant une visite, chacun peut cocher, noter, et AJOUTER des étapes (gardées dans le modèle si on le souhaite) ;
// - photo avant / après facultatives (Internet nécessaire pour les envoyer).

type Item = { text: string; done: boolean; note: string; extra: boolean; showNote: boolean };

async function compressPhoto(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Photo illisible"));
      i.src = url;
    });
    const scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("Compression impossible"))), "image/jpeg", 0.72));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function uploadPhoto(file: File, name: string): Promise<string> {
  const blob = await compressPhoto(file);
  const up = await postG37Upload({ fileName: name, contentType: "image/jpeg", sizeBytes: blob.size });
  const put = await fetch(up.presignedUrl, { method: "PUT", headers: up.headers, body: blob });
  if (!put.ok) throw new Error("Envoi de la photo impossible");
  return up.fileKey;
}

function PhotoSlot({ label, value, busy, onPick, onClear, lang }: {
  label: string; value: string | null; busy: boolean; onPick: (f: File) => void; onClear: () => void; lang: "fr" | "en";
}) {
  const t = (a: string, b: string) => (lang === "fr" ? a : b);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className={styles.photo}>
      <input ref={ref} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onPick(f); }} />
      {value ? (
        <>
          <img src={value} alt={label} className={styles.photoImg} />
          <button type="button" className={styles.photoClear} onClick={onClear} aria-label={t("Retirer la photo", "Remove photo")}>×</button>
        </>
      ) : (
        <button type="button" className={styles.photoBtn} disabled={busy} onClick={() => ref.current?.click()}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
          <span>{busy ? t("Envoi…", "Uploading…") : label}</span>
        </button>
      )}
    </div>
  );
}

/** « Lubrication — Spindle oil change » → ["Lubrication", "Spindle oil change"] ; sans zone → [null, texte]. */
export function splitZone(text: string): [string | null, string] {
  const i = text.indexOf(" — ");
  return i > 0 && i < 60 ? [text.slice(0, i).trim(), text.slice(i + 3).trim()] : [null, text];
}

export function MaintChecklistDialog({ open, onOpenChange, machineNo, state, lang, canEditTemplate, save }: {
  open: boolean; onOpenChange: (o: boolean) => void; machineNo: number | null; state: State; lang: "fr" | "en";
  canEditTemplate: boolean; save: (input: InputType) => void;
}) {
  const t = (a: string, b: string) => (lang === "fr" ? a : b);
  const [items, setItems] = useState<Item[]>([]);
  const [extra, setExtra] = useState("");
  const [notes, setNotes] = useState("");
  const [keepExtras, setKeepExtras] = useState(true);
  const [before, setBefore] = useState<{ key: string; url: string } | null>(null);
  const [after, setAfter] = useState<{ key: string; url: string } | null>(null);
  const [busy, setBusy] = useState<"before" | "after" | null>(null);

  useEffect(() => {
    if (!open) return;
    setItems((state.checklistSteps ?? []).map((s) => ({ text: s.text, done: false, note: "", extra: false, showNote: false })));
    setExtra(""); setNotes(""); setBefore(null); setAfter(null); setKeepExtras(true);
  }, [open, machineNo]);

  const doneCount = items.filter((i) => i.done).length;
  const allDone = items.length > 0 && doneCount === items.length;
  const update = (k: number, patch: Partial<Item>) => setItems((list) => list.map((x, i) => (i === k ? { ...x, ...patch } : x)));

  const pickPhoto = async (which: "before" | "after", f: File) => {
    if (!isOnline()) { toast.error(t("Les photos ont besoin d'Internet. Tu peux enregistrer la check-list sans photo.", "Photos need Internet. You can save the checklist without photos.")); return; }
    setBusy(which);
    try {
      const key = await uploadPhoto(f, `maintenance-mc${machineNo}-${which}.jpg`);
      const url = URL.createObjectURL(f);
      (which === "before" ? setBefore : setAfter)({ key, url });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Photo non envoyée", "Photo not sent"));
    } finally {
      setBusy(null);
    }
  };

  const addExtra = () => {
    const text = extra.trim();
    if (!text) return;
    setItems((list) => [...list, { text: text.slice(0, 200), done: true, note: "", extra: true, showNote: false }]);
    setExtra("");
  };

  const submit = (withList: boolean) => {
    if (!machineNo) return;
    if (withList && !allDone && !window.confirm(t(`${items.length - doneCount} étape(s) non cochée(s). Enregistrer quand même ? Le superviseur sera prévenu.`, `${items.length - doneCount} step(s) not ticked. Save anyway? The supervisor will be notified.`))) return;
    save(withList ? {
      action: "maintDone", machineNo,
      checklist: {
        items: items.map((i) => ({ text: i.text, done: i.done, note: i.note.trim() || null, extra: i.extra })),
        photoBefore: before?.key ?? null, photoAfter: after?.key ?? null, notes: notes.trim() || null,
        saveExtras: canEditTemplate && keepExtras && items.some((i) => i.extra),
      },
    } : { action: "maintDone", machineNo });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={styles.dialog}>
        <DialogHeader>
          <DialogTitle>{t("Maintenance", "Maintenance")} · M/C {machineNo != null ? String(machineNo).padStart(2, "0") : ""}</DialogTitle>
        </DialogHeader>
        <div className={styles.progress} aria-label={t(`${doneCount} étapes faites sur ${items.length}`, `${doneCount} of ${items.length} steps done`)}>
          <div className={styles.progressTop}>
            <span>{t("Check-list", "Checklist")}</span>
            <span className={styles.mono}>{doneCount}/{items.length}</span>
          </div>
          <div className={styles.track}><div className={styles.fill} style={{ width: `${items.length ? (doneCount / items.length) * 100 : 0}%` }} /></div>
        </div>

        <div className={styles.steps}>
          {items.map((it, k) => {
            // « Zone — point » : un titre par zone (fiche Benin Textiles), le point seul sur la ligne.
            const [zone, label] = splitZone(it.text);
            const prevZone = k > 0 ? splitZone(items[k - 1].text)[0] : null;
            const zoneItems = zone ? items.map((x, i) => [x, i] as const).filter(([x]) => splitZone(x.text)[0] === zone) : [];
            const zoneDone = zoneItems.filter(([x]) => x.done).length;
            return (
            <React.Fragment key={k}>
            {zone && zone !== prevZone && (
              <div className={styles.zone}>
                <span className={styles.zoneName}>{zone}</span>
                <span className={styles.zoneCount}>{zoneDone}/{zoneItems.length}</span>
                <button type="button" className={styles.zoneAll} onClick={() => { const all = zoneDone < zoneItems.length; zoneItems.forEach(([, i]) => update(i, { done: all })); }}>
                  {zoneDone < zoneItems.length ? t("Tout cocher", "Tick all") : t("Tout décocher", "Untick all")}
                </button>
              </div>
            )}
            <div className={`${styles.step} ${it.done ? styles.stepDone : ""}`}>
              <label className={styles.stepMain}>
                <input type="checkbox" className={styles.box} checked={it.done} onChange={(e) => update(k, { done: e.target.checked })} />
                <span className={styles.stepText}>{label}{it.extra && <span className={styles.badge}>{t("ajoutée", "added")}</span>}</span>
              </label>
              <button type="button" className={styles.noteBtn} onClick={() => update(k, { showNote: !it.showNote })} aria-label={t("Ajouter une remarque", "Add a remark")}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
              </button>
              {it.showNote && (
                <Input className={styles.noteInput} value={it.note} maxLength={300} placeholder={t("Remarque (pièce usée, réglage…)", "Remark (worn part, setting…)")} onChange={(e) => update(k, { note: e.target.value })} />
              )}
            </div>
            </React.Fragment>
            );
          })}
          {!items.length && <div className={styles.empty}>{t("Le modèle est vide : ajoute tes étapes ci-dessous.", "The template is empty: add your steps below.")}</div>}
        </div>

        <div className={styles.addRow}>
          <Input value={extra} maxLength={200} placeholder={t("Ajouter une étape faite…", "Add a step done…")} onChange={(e) => setExtra(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addExtra(); } }} />
          <Button variant="outline" onClick={addExtra} disabled={!extra.trim()}>{t("Ajouter", "Add")}</Button>
        </div>
        {canEditTemplate && items.some((i) => i.extra) && (
          <label className={styles.keep}>
            <input type="checkbox" className={styles.box} checked={keepExtras} onChange={(e) => setKeepExtras(e.target.checked)} />
            {t("Garder mes nouvelles étapes dans la check-list pour les prochaines fois", "Keep my new steps in the checklist for next time")}
          </label>
        )}

        <div className={styles.photos}>
          <PhotoSlot lang={lang} label={t("Photo avant", "Photo before")} value={before?.url ?? null} busy={busy === "before"} onPick={(f) => void pickPhoto("before", f)} onClear={() => setBefore(null)} />
          <PhotoSlot lang={lang} label={t("Photo après", "Photo after")} value={after?.url ?? null} busy={busy === "after"} onPick={(f) => void pickPhoto("after", f)} onClear={() => setAfter(null)} />
        </div>
        <Input value={notes} maxLength={1000} placeholder={t("Observations générales (facultatif)", "General observations (optional)")} onChange={(e) => setNotes(e.target.value)} />

        <div className={styles.actions}>
          <Button size="lg" onClick={() => submit(true)} disabled={busy !== null}>{t("Enregistrer la maintenance", "Save the maintenance")}</Button>
          <button type="button" className={styles.skip} onClick={() => { if (window.confirm(t("Valider la maintenance sans check-list ?", "Validate the maintenance without a checklist?"))) submit(false); }}>
            {t("Valider sans check-list", "Validate without checklist")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Modèle de la check-list : ajouter, renommer, déplacer, retirer des étapes.
export function ChecklistEditor({ state, lang, save, onClose }: { state: State; lang: "fr" | "en"; save: (input: InputType) => void; onClose: () => void }) {
  const t = (a: string, b: string) => (lang === "fr" ? a : b);
  const steps = state.checklistSteps ?? [];
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [add, setAdd] = useState("");
  return (
    <div className={styles.editor}>
      <div className={styles.editorHead}>
        <div>
          <h2 className={styles.h2}>{t("Modèle de la check-list", "Checklist template")}</h2>
          <p className={styles.sub}>{t("Utilisé à chaque maintenance clg. Les check-lists déjà remplies ne changent pas.", "Used at every cleaning maintenance. Checklists already filled in don't change.")}</p>
        </div>
        <Button variant="outline" onClick={onClose}>{t("Fermer", "Close")}</Button>
      </div>
      {steps.map((s, i) => {
        const v = draft[s.id] ?? s.text;
        const changed = v.trim() && v.trim() !== s.text;
        return (
          <div key={s.id} className={styles.editRow}>
            <span className={styles.editNo}>{i + 1}</span>
            <Input value={v} maxLength={200} onChange={(e) => setDraft((d) => ({ ...d, [s.id]: e.target.value }))} />
            <div className={styles.editBtns}>
              {changed && <Button size="sm" style={{ marginRight: "auto" }} onClick={() => { save({ action: "checklistStepEdit", id: s.id, text: v.trim() }); setDraft((d) => { const n = { ...d }; delete n[s.id]; return n; }); }}>{t("Enregistrer", "Save")}</Button>}
              <button type="button" className={styles.iconBtn} disabled={i === 0} onClick={() => save({ action: "checklistStepMove", id: s.id, dir: "up" })} aria-label={t("Monter", "Move up")}>↑</button>
              <button type="button" className={styles.iconBtn} disabled={i === steps.length - 1} onClick={() => save({ action: "checklistStepMove", id: s.id, dir: "down" })} aria-label={t("Descendre", "Move down")}>↓</button>
              <button type="button" className={`${styles.iconBtn} ${styles.iconDanger}`} onClick={() => { if (window.confirm(t(`Retirer « ${s.text} » ?`, `Remove "${s.text}"?`))) save({ action: "checklistStepDelete", id: s.id }); }} aria-label={t("Retirer", "Remove")}>×</button>
            </div>
          </div>
        );
      })}
      <div className={styles.addRow}>
        <Input value={add} maxLength={200} placeholder={t("Nouvelle étape…", "New step…")} onChange={(e) => setAdd(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && add.trim()) { e.preventDefault(); save({ action: "checklistStepAdd", text: add.trim() }); setAdd(""); } }} />
        <Button onClick={() => { save({ action: "checklistStepAdd", text: add.trim() }); setAdd(""); }} disabled={!add.trim()}>{t("Ajouter", "Add")}</Button>
      </div>
    </div>
  );
}
