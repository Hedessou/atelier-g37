import React, { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { Button } from "./Button";
import { Input } from "./Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./Select";
import { Skeleton } from "./Skeleton";
import { g37, type Perm } from "../helpers/g37";
import { useG37 } from "../helpers/useG37";
import { postG37Upload, MAX_UPLOAD_BYTES } from "../endpoints/g37/upload_POST.schema";
import { getG37Export } from "../endpoints/g37/export_GET.schema";
import { enablePush, disablePush, isPushOptedIn, onPushEnabledChange, onPushMessage } from "../helpers/pushClient";
import type { G37Machine } from "../endpoints/g37/state_GET.schema";
import { AppStatusBar } from "./AppStatusBar";
import { MessagesView } from "./MessagesView";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./Dialog";
import { getP2PStatus, getPeers, p2pStatus, peersChanged, requestP2PPermissions, startP2P } from "../lib/p2p";
import { nearbyAvailable } from "../lib/nearby";
import { unreadFrom, useDms } from "../lib/dms";
import { SettingsView } from "./SettingsView";
import { ProfileView } from "./ProfileView";
import { useAuth } from "../helpers/useAuth";
import { playAlert } from "../lib/sounds";
import { checkRinging } from "../lib/calls";
import { Nearby as NativeNearby, nativeSoundsAvailable } from "../lib/nearby";
import { saveBlob } from "../lib/files";
import { isOnline } from "../lib/net";
import { extractManualChunks, uploadManualChunks } from "../lib/manualPdf";
import { pushSupported } from "../helpers/pushClient";
import styles from "./G37App.module.css";

const TABS: Array<[string, string, string]> = [
  ["accueil", "Accueil", "Dashboard"], ["machines", "Machines", "Machines"], ["travaux", "Travaux", "Work"], ["gears", "Gears", "Gears"], ["calcul", "Calcul", "Calculator"],
  ["maintenance", "Maintenance", "Maintenance"], ["graissage", "Graissage", "Greasing"], ["lubrification", "Lubrification", "Lubrication"], ["schedule", "Schedule works", "Schedule works"],
  ["pannes", "Pannes", "Breakdowns"], ["quarts", "Quarts", "Shifts"], ["discussion", "Messages", "Messages"], ["ia", "IA", "AI"],
  ["magasin", "Magasin", "Store"], ["acces", "Accès", "Access"],
];

const MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Langue courante de l'interface (FR par défaut). Mise à jour par le composant à chaque rendu,
// pour que les petites fonctions de formatage hors composant parlent la même langue.
let LANG: "fr" | "en" = "fr";
const T = (fr: string, en: string) => (LANG === "fr" ? fr : en);
const MONTHS = () => (LANG === "fr" ? MONTHS_FR : MONTHS_EN);

// Libellés métier en anglais (le référentiel helpers/g37 reste en français : les données ne changent pas).
const ROLE_EN: Record<string, string> = {
  admin: "Admin", superviseur: "Supervisor", technicien: "Technician", shift: "Shift technician",
  genmaint: "General maintenance manager", greaser: "Greasing operator", manager: "Manager",
  forman: "Foreman / Boss", prodsup: "Production supervisor", prodman: "Production manager", helper: "Helper",
};
const M_STATUS_EN: Record<string, string> = { service: "Running", arret: "Stopped", maintenance: "Under maintenance" };
const STOP_REASON_EN: Record<string, string> = {
  "Manque de mèche": "No roving", "Manque de commande": "No order", "Changement d'article": "Article change",
  "Manque de personnel": "Staff shortage", "Nettoyage": "Cleaning", "Coupure électrique": "Power cut",
  "Arrêt programmé": "Planned stop", "Pièce en attente": "Waiting for part", "Panne en cours": "Breakdown in progress", "Autre": "Other",
};
const SHIFT_EN: Record<string, string> = { m: "Morning", s: "Afternoon", n: "Night", r: "Rest" };
const roleName = (key: string, fallback: string) => (LANG === "fr" ? fallback : ROLE_EN[key] ?? fallback);
const statusName = (key: string, fallback: string) => (LANG === "fr" ? fallback : M_STATUS_EN[key] ?? fallback);
const stopReasonName = (v: string | null | undefined) => (!v ? v : LANG === "fr" ? v : STOP_REASON_EN[v] ?? v);
const shiftName = (key: string, fallback: string) => (LANG === "fr" ? fallback : SHIFT_EN[key] ?? fallback);
// Les libellés de réglages sont écrits "Anglais — français" : on garde la moitié qui convient.
const specLabel = (label: string) => (LANG === "fr" ? label : label.split(" — ")[0]);
const plural = (n: number) => (n > 1 ? "s" : "");
const todayISO = () => new Date().toISOString().slice(0, 10);
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
const dayISO = (d: Date | string) => (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));
const nf = (v: number, dec = 2) => v.toLocaleString("fr-FR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
const parseNum = (s: string | undefined) => {
  const v = (s ?? "").replace(",", ".").trim();
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function fmtDate(v: Date | string | null | undefined) {
  if (!v) return "—";
  const s = dayISO(v);
  const [y, m, d] = s.split("-");
  return LANG === "fr"
    ? `${d} ${MONTHS_FR[Number(m) - 1].slice(0, 4)}. ${y}`
    : `${MONTHS_EN[Number(m) - 1].slice(0, 3)} ${Number(d)}, ${y}`;
}
function addDays(isoDay: string, n: number) {
  const d = new Date(isoDay + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysTo(isoDay: string) {
  return Math.round((new Date(isoDay + "T00:00:00Z").getTime() - new Date(todayISO() + "T00:00:00Z").getTime()) / 86400000);
}
function dueTone(n: number | null): "ok" | "warn" | "crit" | "" {
  if (n == null) return "";
  return n < 0 ? "crit" : n <= 5 ? "warn" : "ok";
}
function dueText(n: number | null) {
  if (n == null) return T("jamais fait", "never done");
  return n < 0 ? T(`en retard de ${-n} j`, `${-n} d overdue`) : n === 0 ? T("aujourd'hui", "today") : T(`dans ${n} j`, `in ${n} d`);
}
function fmtDur(a: Date | string | null, b: Date | string | null) {
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (!(ms > 0)) return null;
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return (h ? `${h} h ` : "") + (m || !h ? `${m} min` : "");
}

// Son d'alerte choisi dans les Paramètres (repli : notes synthétisées).
function alertSound() {
  void playAlert("alert");
}
export function legacyAlertSound() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [0, 0.26].forEach((offset, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = i === 0 ? 988 : 784;
      const t = ctx.currentTime + offset;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.start(t);
      osc.stop(t + 0.24);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1200);
  } catch {
    // Le navigateur peut refuser le son tant que la personne n'a pas touché l'écran.
  }
}

function fmtSeen(v: Date | string | null | undefined) {
  if (!v) return T("jamais connecté", "never signed in");
  const ms = Date.now() - new Date(v).getTime();
  if (ms < 0) return T("à l'instant", "just now");
  const min = Math.floor(ms / 60000);
  if (min < 2) return T("à l'instant", "just now");
  if (min < 60) return T(`il y a ${min} min`, `${min} min ago`);
  const h = Math.floor(min / 60);
  if (h < 24) return T(`il y a ${h} h`, `${h} h ago`);
  const j = Math.floor(h / 24);
  if (j === 1) return T("hier", "yesterday");
  if (j < 30) return T(`il y a ${j} jours`, `${j} days ago`);
  return fmtDate(v);
}

const Pill = ({ tone, children }: { tone?: string; children: React.ReactNode }) => (
  <span className={`${styles.pill} ${tone === "ok" ? styles.pillOk : tone === "warn" ? styles.pillWarn : tone === "crit" ? styles.pillCrit : tone === "accent" ? styles.pillAccent : ""}`}>
    {children}
  </span>
);

const Picker = ({ value, onChange, options, placeholder, label }: {
  value: string; onChange: (v: string) => void;
  options: Array<[string, string]>; placeholder?: string; label?: string;
}) => (
  <label className={styles.field}>
    {label ? <span className={styles.fieldLabel}>{label}</span> : null}
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue placeholder={placeholder ?? T("Choisir", "Choose")} /></SelectTrigger>
      <SelectContent>
        {options.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
      </SelectContent>
    </Select>
  </label>
);

export const G37App = ({ className }: { className?: string }) => {
  const { state, isLoading, save, isSaving } = useG37();
  const [lang, setLang] = useState<"fr" | "en">(() => (localStorage.getItem("g37-language") as "fr" | "en") || "fr");
  const t = (fr: string, en: string) => lang === "fr" ? fr : en;
  LANG = lang;
  useEffect(() => { localStorage.setItem("g37-language", lang); }, [lang]);
  const [tab, setTab] = useState(() => {
    // Raccourcis de l'app installée (manifest) : /?tab=machines, /?tab=pannes, /?tab=magasin
    try {
      const wanted = new URLSearchParams(window.location.search).get("tab");
      if (wanted && TABS.some(([k]) => k === wanted)) return wanted;
    } catch { /* ignore */ }
    return "accueil";
  });
  useEffect(() => {
    const open = (e: Event) => {
      const raw = (e as CustomEvent<string>).detail;
      const k = raw === "messages" ? "discussion" : raw;
      if (TABS.some(([key]) => key === k) || k === "parametres" || k === "profil") { setTab(k); window.scrollTo(0, 0); }
    };
    window.addEventListener("g37:open-tab", open);
    return () => window.removeEventListener("g37:open-tab", open);
  }, []);
  const [openMachine, setOpenMachine] = useState<number | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const { logout } = useAuth();
  // Autorisations importantes manquantes (affiche un rappel sur l'accueil).
  const [permMissing, setPermMissing] = useState(0);
  useEffect(() => {
    const check = async () => {
      if (!(await nativeSoundsAvailable())) return;
      const st = await NativeNearby.getSystemStatus().catch(() => null);
      if (!st) return;
      const list = [st.notifications, st.nearby, st.microphone, st.bluetooth, st.battery, st.sdk >= 34 ? st.fullScreen : true, st.locationNeeded ? st.location : true];
      setPermMissing(list.filter((x) => !x).length);
    };
    void check();
    const onVis = () => { if (document.visibilityState === "visible") { void check(); void checkRinging(); } };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  const [msgSegment, setMsgSegment] = useState<"chats" | "calls">("chats");
  const dmList = useDms();
  // Mode sans Internet : état et collègues à proximité.
  const [p2p, setP2p] = useState(getP2PStatus());
  const [nearCount, setNearCount] = useState(() => getPeers().filter((p) => p.connected).length);
  useEffect(() => {
    const a = p2pStatus.on(setP2p);
    const b = peersChanged.on((list) => setNearCount(list.filter((p) => p.connected).length));
    return () => { a(); b(); };
  }, []);
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [shiftMonth, setShiftMonth] = useState(monthKey());
  const [editSpecs, setEditSpecs] = useState(false);
  const [chatFile, setChatFile] = useState<File | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatReply, setChatReply] = useState<{ id: string; author: string; message: string } | null>(null);
  const [chatMentions, setChatMentions] = useState<number[]>([]);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Sauvegarde : télécharge tout l'historique de l'atelier dans un fichier Excel (admin uniquement).
  const downloadBackup = async () => {
    setExportBusy(true);
    try {
      if (!isOnline()) throw new Error(t("La sauvegarde Excel nécessite Internet.", "The Excel backup needs Internet."));
      const { blob, fileName } = await getG37Export();
      await saveBlob(blob, fileName);
      toast.success(t("Sauvegarde téléchargée.", "Backup downloaded."));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Export impossible", "Export failed"));
    } finally {
      setExportBusy(false);
    }
  };

  const d = (k: string, fallback = "") => draft[k] ?? fallback;
  const setD = (k: string, v: string) => setDraft((p) => ({ ...p, [k]: v }));

  const me = state?.me;
  const can = (p: Perm) => g37.can(p, me);

  const machines = state?.machines ?? [];
  const byNo = useMemo(() => {
    const m = new Map<number, G37Machine>();
    machines.forEach((x) => m.set(x.no, x));
    return m;
  }, [machines]);

  const gearStock = (type: "G" | "H", teeth: number) =>
    state?.gears.find((g) => g.gearType === type && g.teeth === teeth)?.stock ?? 0;
  const gearMachines = (type: "G" | "H", teeth: number) =>
    machines.filter((m) => (type === "G" ? m.runG : m.runH) === teeth).map((m) => m.no);

  // Dernière opération de graissage/lubrification par machine et par point.
  const lastCycle = useMemo(() => {
    const m = new Map<string, { doneOn: string; who: string | null }>();
    (state?.greasing ?? []).forEach((r) => {
      const k = `${r.kind}:${r.machineNo}:${r.pointKey}`;
      const day = dayISO(r.doneOn);
      const prev = m.get(k);
      if (!prev || prev.doneOn < day) m.set(k, { doneOn: day, who: r.authorName });
    });
    return m;
  }, [state?.greasing]);

  const cycleHistory = (kind: string, no: number, pointKey: string) =>
    (state?.greasing ?? [])
      .filter((r) => r.kind === kind && r.machineNo === no && r.pointKey === pointKey)
      .slice(0, 5);

  // Points d'origine + types ajoutés (graissage, lubrification, travaux planifiés).
  type CyclePt = { k: string; n: string; d: number; id?: string };
  const pointsOf = (kind: "grease" | "lub" | "sched"): CyclePt[] => {
    const base: CyclePt[] = kind === "grease" ? g37.GREASE_POINTS : kind === "lub" ? g37.LUB_BOXES : [];
    const extra: CyclePt[] = (state?.cyclePoints ?? []).filter((p) => p.kind === kind).map((p) => ({ k: p.key, n: p.name, d: p.days, id: p.id }));
    return [...base, ...extra];
  };
  const daysFor = (kind: "grease" | "lub" | "sched", p: CyclePt, no: number) => p.id ? p.d : g37.cycleDays(kind, p.k, no);

  const openFaults = (state?.failures ?? []).filter((f) => f.status !== "resolue");
  const lowStock = (state?.stock ?? []).filter((s) => Number(s.quantity) < Number(s.minimumQuantity || g37.STOCK_ALERT));
  const todoWorks = (state?.works ?? []).filter((w) => w.status === "todo");
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantMessages, setAssistantMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const [manualImported, setManualImported] = useState(false);
  const manualReady = manualImported || !!state?.manualReady;
  const [manualImportBusy, setManualImportBusy] = useState(false);
  const [manualProgress, setManualProgress] = useState("");
  const manualInput = useRef<HTMLInputElement>(null);

  const assistantContext = useMemo(() => {
    // L’assistant reçoit le référentiel G37 complet, pas seulement un résumé :
    // caractéristiques machine, réglages par groupe, historique, stock, gears,
    // maintenance/graissage, quarts, rendement et discussion.
    const fullContext = {
      machines: machines.map((m) => ({
        ...m,
        draft: g37.draftOf(m.runG, m.runH),
        specs: state?.specs?.find((s) => s.groupId === m.groupId)?.fields ?? null,
      })),
      stock: state?.stock ?? [],
      gears: state?.gears ?? [],
      failures: state?.failures ?? [],
      works: state?.works ?? [],
      maintenance: state?.maintenance ?? [],
      greasing: state?.greasing ?? [],
      // Types de graissage / lubrification / travaux planifiés (kind "sched" dans greasing) et leur périodicité en jours.
      cyclePoints: state?.cyclePoints ?? [],
      shifts: state?.shifts ?? [],
      efficiency: state?.efficiency ?? [],
      specs: state?.specs ?? [],
      chat: state?.chat ?? [],
    };
    return JSON.stringify(fullContext);
  }, [machines, state?.stock, state?.gears, state?.failures, state?.works, state?.maintenance, state?.greasing, state?.cyclePoints, state?.shifts, state?.efficiency, state?.specs, state?.chat]);

  // Import du manuel : le PDF est lu directement sur le téléphone, seul le texte est envoyé au serveur.
  const importManualPdf = async (file: File) => {
    if (manualImportBusy) return;
    if (!isOnline()) { toast.error(t("L'import du manuel nécessite Internet.", "Importing the manual needs Internet.")); return; }
    setManualImportBusy(true);
    try {
      let chunks: Array<{ pageStart: number; pageEnd: number; content: string }>;
      if (/\.(jsonl|txt)$/i.test(file.name)) {
        chunks = (await file.text()).split("\n").filter((l) => l.trim()).map((l) => {
          const o = JSON.parse(l);
          return { pageStart: o.page_start, pageEnd: o.page_end, content: o.content };
        });
      } else {
        chunks = await extractManualChunks(file, (p, total) => setManualProgress(t(`Lecture page ${p}/${total}`, `Reading page ${p}/${total}`)));
      }
      if (!chunks.length) throw new Error(t("Aucun texte trouvé dans ce PDF (PDF scanné ?).", "No text found in this PDF (scanned PDF?)."));
      await uploadManualChunks(chunks, file.name, (done, total) => setManualProgress(t(`Envoi ${done}/${total}`, `Uploading ${done}/${total}`)));
      setManualImported(true);
      toast.success(t(`Manuel G37 indexé (${chunks.length} sections). L'IA le consulte avant le Web.`, `G37 manual indexed (${chunks.length} sections). The AI consults it before the Web.`));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("Import du manuel impossible.", "Manual import failed."));
    } finally {
      setManualImportBusy(false);
      setManualProgress("");
    }
  };

  // Les paiements sont supprimés : l'IA et le calcul sont illimités pour tous.
  const quotaLine = (_kind: "ai" | "calc"): string | null => null;

  const askAssistant = async () => {
    const message = assistantInput.trim();
    if (!message || assistantBusy) return;
    if (!isOnline()) { toast.error(t("L'assistant IA nécessite Internet.", "The AI assistant needs Internet.")); return; }
    setAssistantInput("");
    setAssistantMessages((p) => [...p, { role: "user", text: message }]);
    setAssistantBusy(true);
    try {
      const response = await fetch("/_api/g37/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, language: lang, context: assistantContext, history: assistantMessages.slice(-8).map((m) => ({ role: m.role, text: m.text.slice(0, 3500) })) }),
      });
      const data = await response.json().catch(() => ({}));
      if (data.code === "OUT_OF_CREDITS") {
        setAssistantMessages((p) => [...p, { role: "assistant", text: t("Le moteur IA est temporairement indisponible (clé ou quota Gemini). Les données G37 restent disponibles ; réessaie plus tard.", "The AI engine is temporarily unavailable (Gemini key or quota). G37 data remains available; try again later.") }]);
        return;
      }
      if (!response.ok) throw new Error(data.error || "Assistant unavailable");
      setAssistantMessages((p) => [...p, { role: "assistant", text: data.answer || t("Je n’ai pas trouvé de réponse dans les données de l’atelier.", "I could not find an answer in the workshop data.") }]);
    } catch (err) {
      console.error(err);
      setAssistantMessages((p) => [...p, { role: "assistant", text: t("Assistant indisponible pour le moment.", "Assistant unavailable right now.") }]);
    } finally {
      setAssistantBusy(false);
    }
  };

  const renderAssistant = () => (
    <div className={styles.stack}>
      <div className={styles.head}>
        <h1 className={styles.title}>IA G37</h1>
        <p className={styles.sub}>{t("Assistant technique · atelier · diagnostic", "Technical assistant · workshop · diagnosis")}</p>
        {quotaLine("ai") && <p className={styles.meta}>{quotaLine("ai")}</p>}
      </div>
      {me?.role === "admin" && (
        <div className={styles.card}>
          <div className={`${styles.row} ${styles.between}`}>
            <div>
              <strong>{t("Manuel technique G37", "G37 technical manual")}</strong>
              <div className={styles.meta}>{manualReady
                ? t("Le manuel est indexé : l'IA le consulte avant le Web. Tu peux le remplacer par une nouvelle version.", "The manual is indexed: the AI consults it before the Web. You can replace it with a new version.")
                : t("Envoie le PDF du manuel : il est lu sur le téléphone, puis l'IA s'en sert pour répondre.", "Send the manual PDF: it is read on the phone, then the AI uses it to answer.")}</div>
              {manualProgress && <div className={styles.meta}>{manualProgress}</div>}
            </div>
            <input ref={manualInput} type="file" accept="application/pdf,.pdf,.jsonl,.txt" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importManualPdf(f); }} />
            <Button variant="outline" size="sm" disabled={manualImportBusy} onClick={() => manualInput.current?.click()}>
              {manualImportBusy ? t("Indexation…", "Indexing…") : manualReady ? t("Remplacer le manuel (PDF)", "Replace the manual (PDF)") : t("Importer le manuel (PDF)", "Import the manual (PDF)")}
            </Button>
          </div>
        </div>
      )}
      <section className={styles.card} style={{ minHeight: "min(720px, calc(100vh - 250px))", display: "flex", flexDirection: "column" }} aria-label={t("Assistant atelier", "Workshop assistant")}>
        <div className={styles.assistantHead}>
          <div><strong>Assistant G37</strong><div className={styles.meta}>{t(`Données G37 · manuel technique ${manualReady ? "✓ chargé" : "· non indexé"} · diagnostic · web complémentaire`, `G37 data · technical manual ${manualReady ? "✓ loaded" : "· not indexed"} · diagnosis · complementary web`)}</div></div>
        </div>
        <div className={styles.assistantBody} style={{ minHeight: 320 }}>
          {!assistantMessages.length && <div className={styles.note}>{t("Pose une question sur les machines, les réglages, les pannes, le magasin, le Draft/Count ou une procédure technique.", "Ask about machines, settings, faults, store, Draft/Count, or a technical procedure.")}</div>}
          {assistantMessages.map((m, i) => <div key={i} className={m.role === "user" ? styles.assistantUser : styles.assistantBot}>{m.text}</div>)}
          {assistantBusy && <div className={styles.assistantTyping}>{t("Analyse en cours…", "Analyzing…")}</div>}
        </div>
        <div className={styles.assistantComposer}>
          <Input value={assistantInput} onChange={(e) => setAssistantInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void askAssistant(); } }} placeholder={t("Ex. Quelle est la procédure pour cette alarme ?", "E.g. What is the procedure for this alarm?")} disabled={assistantBusy} />
          <Button onClick={() => void askAssistant()} disabled={assistantBusy || !assistantInput.trim()}>{t("Envoyer", "Send")}</Button>
        </div>
      </section>
    </div>
  );

  const specsOf = (no: number) => {
    const base = g37.groupOf(no);
    const ov = state?.specs.find((s) => s.groupId === base.id)?.fields as Record<string, string> | undefined;
    return { ...base, ...(ov ?? {}) };
  };

  const [pushOn, setPushOn] = useState(() => isPushOptedIn());
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => {
    setPushOn(isPushOptedIn());
    return onPushEnabledChange(setPushOn);
  }, []);
  // Si le navigateur a déjà accordé la permission mais que l'état local du site
  // a été effacé (nettoyage du navigateur, mise à jour, etc.), réassocier ce
  // téléphone sans réafficher de demande d'autorisation.
  useEffect(() => {
    if (pushOn || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    let cancelled = false;
    void enablePush().then(() => {
      if (!cancelled && !isPushOptedIn()) {
        toast.error(t("Autorisation présente, mais ce navigateur ne permet pas de recevoir les notifications push. Vérifie le navigateur et l'installation de l'application.", "Permission is granted, but this browser cannot receive push notifications. Check the browser and app installation."));
      }
    }).catch((error) => {
      console.error("Push resubscription failed:", error);
      if (!cancelled) toast.error(t("Impossible de rétablir les notifications sur cet appareil.", "Could not restore notifications on this device."));
    });
    return () => { cancelled = true; };
  }, [pushOn, lang]);
  // Une notification reçue site ouvert : on la montre et on la fait sonner.
  useEffect(() => onPushMessage((payload) => {
    const kind = payload.data?.kind;
    if (kind === "call" || kind === "call_end") { void checkRinging(); return; }
    if (!payload.title) return;
    if (kind === "dm" || kind === "chat") {
      void playAlert("message");
      toast(`${payload.title}${payload.body ? ` — ${payload.body}` : ""}`);
      return;
    }
    alertSound();
    toast.error(`${payload.title}${payload.body ? ` — ${payload.body}` : ""}`);
  }), []);

  // Alerte sonore dès qu'une panne de plus apparaît, même sur un autre poste.
  const openCount = openFaults.length;
  const prevOpenCount = useRef<number | null>(null);
  useEffect(() => {
    if (prevOpenCount.current !== null && openCount > prevOpenCount.current) {
      alertSound();
      toast.error(t(`Nouvelle panne signalée — ${openCount} panne${plural(openCount)} ouverte${plural(openCount)}`, `New fault reported — ${openCount} open fault${plural(openCount)}`));
    }
    prevOpenCount.current = openCount;
  }, [openCount]);

  if (isLoading && !state) {
    return (
      <div className={`${styles.app} ${className ?? ""}`}>
        <div className={styles.shell}>
          <div className={styles.stack}>
            <Skeleton style={{ height: 40 }} />
            <Skeleton style={{ height: 120 }} />
            <Skeleton style={{ height: 240 }} />
          </div>
        </div>
      </div>
    );
  }
  if (!state || !me) {
    return <div className={`${styles.app} ${className ?? ""}`}><div className={styles.center}>{t("Impossible de charger l'atelier.", "Unable to load the workshop.")}</div></div>;
  }

  /* ---------- Accueil ---------- */
  const running = machines.filter((m) => m.status === "service").length;
  const stopped = machines.filter((m) => m.status !== "service");
  const downtimeHours = (state.failures ?? [])
    .filter((f) => dayISO(f.openedAt).slice(0, 7) === monthKey())
    .reduce((a, f) => {
      const ms = f.stoppedAt && f.restartedAt ? new Date(f.restartedAt).getTime() - new Date(f.stoppedAt).getTime() : 0;
      return a + (ms > 0 ? ms / 3600000 : 0);
    }, 0);

  const maintDue = machines.filter((m) => m.nextMaintenance && daysTo(dayISO(m.nextMaintenance)) <= 7);
  const cycleDue: Array<{ no: number; what: string; days: number; kind: "grease" | "lub" | "sched"; key: string }> = [];
  machines.forEach((m) => {
    (["grease", "lub", "sched"] as const).forEach((kind) => {
      pointsOf(kind).forEach((p) => {
        const last = lastCycle.get(`${kind}:${m.no}:${p.k}`);
        if (!last) return;
        const n = daysTo(addDays(last.doneOn, daysFor(kind, p, m.no)));
        if (n <= 3) cycleDue.push({ no: m.no, what: p.n, days: n, kind, key: p.k });
      });
    });
  });
  cycleDue.sort((a, b) => a.days - b.days);

  const kpi = (value: React.ReactNode, label: string, tone?: string) => (
    <div className={`${styles.kpi} ${tone === "ok" ? styles.toneOk : tone === "warn" ? styles.toneWarn : tone === "crit" ? styles.toneCrit : ""}`}>
      <div className={styles.kpiValue}>{value}</div>
      <div className={styles.kpiLabel}>{label}</div>
    </div>
  );

  const stoppedCount = machines.filter((m) => m.status === "arret").length;
  const maintCount = machines.filter((m) => m.status === "maintenance").length;
  const todo = [
    ...maintDue.map((m) => ({ key: `m${m.no}`, no: m.no, what: t("Visite périodique", "Periodic visit"), days: daysTo(dayISO(m.nextMaintenance!)) })),
    ...cycleDue.map((c, i) => ({ key: `c${i}`, no: c.no, what: c.what, days: c.days })),
  ].sort((a, b) => a.days - b.days).slice(0, 5);
  const whenColor = (n: number) => (n < 0 ? "#fca5a5" : n === 0 ? "#fcd34d" : "var(--g-dim)");
  const goto = (k: string) => { setTab(k); setOpenMachine(null); setQ(""); window.scrollTo(0, 0); };

  const renderAccueil = () => (
    <div className={styles.stack}>
      <div className={styles.statusCard}>
        <div className={styles.statusTop}>
          <strong>{t("État des métiers", "Machine status")}</strong>
          <span className={styles.statusTotal}>{machines.length}</span>
        </div>
        <div className={styles.statusBar} aria-hidden="true">
          {running > 0 && <span style={{ flex: running, background: "var(--g-ok)" }} />}
          {stoppedCount > 0 && <span style={{ flex: stoppedCount, background: "var(--g-crit)" }} />}
          {maintCount > 0 && <span style={{ flex: maintCount, background: "var(--g-warn)" }} />}
        </div>
        <div className={styles.statusLegend}>
          <div><span className={styles.statusNum} style={{ color: "var(--g-ok)" }}>{running}</span>{t("En service", "Running")}</div>
          <div><span className={styles.statusNum} style={{ color: "var(--g-crit)" }}>{stoppedCount}</span>{t("À l'arrêt", "Stopped")}</div>
          <div><span className={styles.statusNum} style={{ color: "var(--g-warn)" }}>{maintCount}</span>{t("Maintenance", "Maintenance")}</div>
        </div>
      </div>
      <div className={styles.tiles}>
        <button className={`${styles.tile} ${openFaults.length ? styles.tileCrit : styles.tileOk}`} onClick={() => goto("pannes")}>
          <span className={styles.tileNum}>{openFaults.length}</span><span>{t("Pannes ouvertes", "Open faults")}</span>
        </button>
        <button className={`${styles.tile} ${cycleDue.length ? styles.tileWarn : styles.tileOk}`} onClick={() => goto("graissage")}>
          <span className={styles.tileNum}>{cycleDue.length}</span><span>{t("Graissages dus", "Greasing due")}</span>
        </button>
      </div>
      <div className={styles.quick}>
        <button className={`${styles.quickBtn} ${styles.quickPrimary}`} onClick={() => goto("pannes")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l10 18H2L12 3z" /><path d="M12 10v5" /><path d="M12 18h.01" /></svg>
          {t("Panne", "Fault")}
        </button>
        <button className={styles.quickBtn} onClick={() => { setMsgSegment("calls"); goto("discussion"); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></svg>
          {t("Appeler", "Call")}
        </button>
        <button className={styles.quickBtn} onClick={() => { setMsgSegment("chats"); goto("discussion"); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /></svg>
          Message
        </button>
      </div>
      <div>
        <h2 className={styles.h2} style={{ margin: "6px 0 8px" }}>{t("À faire aujourd'hui", "To do today")}</h2>
        <div className={styles.stack} style={{ paddingTop: 0, gap: 8 }}>
          {todo.length ? todo.map((x) => (
            <div key={x.key} className={styles.todoRow}>
              <span className={styles.todoMc}>M/C {String(x.no).padStart(2, "0")}</span>
              <span className={styles.todoWhat}>{x.what}</span>
              <span className={styles.todoWhen} style={{ color: whenColor(x.days) }}>{dueText(x.days)}</span>
            </div>
          )) : <div className={styles.empty}>{t("Rien d'échu pour l'instant.", "Nothing due for now.")}</div>}
        </div>
      </div>
      <div className={styles.kpis}>
        {kpi(`${running} / ${machines.length}`, t("Métiers en service", "Machines running"), stopped.length ? "warn" : "ok")}
        {kpi(openFaults.length, t("Pannes ouvertes", "Open faults"), openFaults.length ? "crit" : "ok")}
        {kpi(maintDue.length, t("Maintenances dues", "Maintenance due"), maintDue.length ? "warn" : "ok")}
        {kpi(cycleDue.length, t("Graissages en retard", "Greasing overdue"), cycleDue.length ? "warn" : "ok")}
        {kpi(downtimeHours.toFixed(1), t("Heures d'arrêt ce mois", "Downtime hours this month"), downtimeHours ? "warn" : "ok")}
        {kpi(lowStock.length, t("Articles sous le seuil", "Items below threshold"), lowStock.length ? "crit" : "ok")}
      </div>

      {running > 0 && (
        <div className={styles.card}>
          <div className={styles.head}><h2 className={styles.h2}>{t("Machines en marche", "Machines running")}</h2><p className={styles.sub}>{running} {t("sur", "of")} {machines.length}</p></div>
          <div className={styles.row} style={{ flexWrap: "wrap", gap: 6 }}>
            {machines.filter((m) => m.status === "service").map((m) => <Pill key={m.no} tone="ok">M/C {m.no}</Pill>)}
          </div>
        </div>
      )}

      <div className={styles.two}>
        <div className={styles.card}>
          <div className={styles.head}><h2 className={styles.h2}>{t("Travaux en retard ou à faire", "Overdue or pending work")}</h2><p className={styles.sub}>{todoWorks.length}</p></div>
          {todoWorks.length ? todoWorks.slice(0, 8).map((w) => (
            <div key={w.id} className={`${styles.item} ${styles.row} ${styles.between}`}>
              <div>
                <strong>{w.title}</strong> <Pill tone="accent">M/C {w.machineNo}</Pill>
                <div className={styles.meta}>{w.authorName} · {fmtDate(w.createdAt)}{daysTo(dayISO(w.createdAt)) < 0 ? ` · ${t(`En attente depuis ${-daysTo(dayISO(w.createdAt))} j`, `Waiting ${-daysTo(dayISO(w.createdAt))} d`)}` : ""}</div>
              </div>
              {can("works") && <Button size="sm" disabled={isSaving} onClick={() => { if (window.confirm(t(`Marquer « ${w.title} » comme fait ?`, `Mark "${w.title}" as done?`))) save({ action: "workDone", id: w.id }); }}>{t("Fait", "Done")}</Button>}
            </div>
          )) : <div className={styles.empty}>{t("Aucun travail en attente.", "No pending work.")}</div>}
        </div>
        <div className={styles.card}>
          <div className={styles.head}><h2 className={styles.h2}>{t("Échéances proches", "Upcoming deadlines")}</h2></div>
          {maintDue.length || cycleDue.length ? (
            <>
              {maintDue.slice(0, 5).map((m) => (
                <div key={`mt${m.no}`} className={`${styles.item} ${styles.row} ${styles.between}`}>
                  <div><strong>Maintenance</strong> · M/C {m.no}</div>
                  <div className={styles.row} style={{ gap: 6 }}>
                    <Pill tone={dueTone(daysTo(dayISO(m.nextMaintenance!)))}>{dueText(daysTo(dayISO(m.nextMaintenance!)))}</Pill>
                    {can("maint") && <Button size="sm" disabled={isSaving} onClick={() => { if (window.confirm(t(`Maintenance de la M/C ${m.no} faite ?`, `M/C ${m.no} maintenance done?`))) save({ action: "maintDone", machineNo: m.no }); }}>{t("Fait", "Done")}</Button>}
                  </div>
                </div>
              ))}
              {cycleDue.slice(0, 6).map((c, i) => (
                <div key={`cy${i}`} className={`${styles.item} ${styles.row} ${styles.between}`}>
                  <div><strong>{c.kind === "grease" ? t("Graissage", "Greasing") : c.kind === "lub" ? t("Lubrification", "Lubrication") : "Schedule works"}</strong> · M/C {c.no}<div className={styles.meta}>{c.what}</div></div>
                  <div className={styles.row} style={{ gap: 6 }}>
                    <Pill tone={dueTone(c.days)}>{dueText(c.days)}</Pill>
                    {(c.kind === "sched" ? can("works") : can("grease")) && <Button size="sm" disabled={isSaving} onClick={() => { if (window.confirm(t(`${c.what} sur M/C ${c.no} : fait aujourd'hui ?`, `${c.what} on M/C ${c.no}: done today?`))) save({ action: "cycle", kind: c.kind, pointKey: c.key, from: c.no, to: c.no }); }}>{t("Fait", "Done")}</Button>}
                  </div>
                </div>
              ))}
            </>
          ) : <div className={styles.empty}>{t("Rien d'échu pour l'instant.", "Nothing due for now.")}</div>}
        </div>
      </div>
    </div>
  );

  /* ---------- Machines ---------- */
  const renderMachineList = () => (
    <div className={styles.stack}>
      <div className={styles.head}><h1 className={styles.title}>{t(`Les ${machines.length} métiers`, `The ${machines.length} machines`)}</h1><p className={styles.sub}>{t("Groupes A à E du manuel G37", "Groups A to E of the G37 manual")}</p></div>
      {g37.GROUPS.map((grp) => {
        const sp = specsOf(grp.from);
        return (
          <div key={grp.id}>
            <div className={styles.row} style={{ marginBottom: 8 }}>
              <span className={styles.eyebrow}>{t("Groupe", "Group")} {grp.id} · M/C {grp.from} {t("à", "to")} {grp.to}</span>
              <Pill>Ring {sp.ring}</Pill><Pill>ACL {sp.acl}</Pill>
            </div>
            <div className={styles.machines}>
              {machines.filter((m) => m.no >= grp.from && m.no <= grp.to).map((m) => {
                const f = openFaults.filter((x) => x.machineNo === m.no).length;
                return (
                  <button key={m.no} className={styles.mcard} onClick={() => { setOpenMachine(m.no); setEditSpecs(false); }}>
                    <span className={styles.mcardNo}>M/C {m.no}</span>
                    <span className={styles.mcardSub}>G Z {m.runG ?? "—"} · H Z {m.runH ?? "—"} · Draft {(() => { const dr = g37.draftOf(m.runG, m.runH); return dr ? nf(dr) : "—"; })()}</span>
                    <Pill tone={g37.M_STATUS[m.status]?.tone}>{statusName(m.status, g37.M_STATUS[m.status]?.n ?? m.status)}{m.stopReason ? ` · ${stopReasonName(m.stopReason)}` : ""}</Pill>
                    {f > 0 && <Pill tone="crit">{f} {t("panne", "fault")}{plural(f)}</Pill>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );

  const renderMachine = (no: number) => {
    const m = byNo.get(no);
    if (!m) return <div className={styles.empty}>{t("Machine introuvable.", "Machine not found.")}</div>;
    const grp = g37.groupOf(no);
    const sp = specsOf(no);
    const works = (state.works ?? []).filter((w) => w.machineNo === no);
    const faults = (state.failures ?? []).filter((f) => f.machineNo === no);
    const eff = state.efficiency.find((e) => e.machineNo === no && e.month === monthKey());
    const k = (s: string) => `m${no}.${s}`;
    // Draft = 16,068 × H ÷ G, recalculé à chaque frappe dans les cases G et H.
    const gNow = Number(d(k("g"), m.runG?.toString() ?? ""));
    const hNow = Number(d(k("h"), m.runH?.toString() ?? ""));
    const liveDraft = g37.inGearRange("G", gNow) && g37.inGearRange("H", hNow) ? g37.draftOf(gNow, hNow) : null;
    const savedDraft = g37.draftOf(m.runG, m.runH);

    return (
      <div className={styles.stack}>
        <div className={styles.row}>
          <Button variant="outline" size="sm" onClick={() => setOpenMachine(null)}>{t("← Toutes les machines", "← All machines")}</Button>
        </div>
        <div className={styles.head}>
          <h1 className={styles.title}>M/C {no}</h1>
          <Pill tone={g37.M_STATUS[m.status]?.tone}>{statusName(m.status, g37.M_STATUS[m.status]?.n ?? m.status)}</Pill>
          {m.stopReason && <Pill>{stopReasonName(m.stopReason)}{m.stoppedSince ? ` · ${t("depuis", "for")} ${fmtDur(m.stoppedSince, new Date())}` : ""}</Pill>}
          <p className={styles.sub}>{t("Groupe", "Group")} {grp.id} · Rieter G37</p>
        </div>

        <div className={styles.card}>
          <div className={styles.head}><h2 className={styles.h2}>{t("Relevés", "Readings")}</h2></div>
          <div className={styles.kpis}>
            {kpi(m.runG ?? "—", "Running G Z")}
            {kpi(m.runH ?? "—", "Running H Z")}
            {kpi(savedDraft ? nf(savedDraft) : "—", "Draft")}
            {kpi(eff ? `${Number(eff.value).toFixed(1)} %` : "—", `${t("Efficacité", "Efficiency")} ${MONTHS()[new Date().getMonth()]}`)}
          </div>
          {(m.runG != null || m.runH != null) && (
            <div className={styles.meta} style={{ marginTop: 8 }}>
              {m.runG != null && <>G Z{m.runG} → {g37.GEARS_PER_MACHINE} {t("montés", "mounted")}, <strong>{gearStock("G", m.runG)}</strong> {t("en magasin", "in store")}{gearStock("G", m.runG) < g37.GEARS_PER_MACHINE ? t(" (moins d'un jeu)", " (less than one set)") : ""}<br /></>}
              {m.runH != null && <>H Z{m.runH} → {g37.GEARS_PER_MACHINE} {t("montés", "mounted")}, <strong>{gearStock("H", m.runH)}</strong> {t("en magasin", "in store")}{gearStock("H", m.runH) < g37.GEARS_PER_MACHINE ? t(" (moins d'un jeu)", " (less than one set)") : ""}</>}
            </div>
          )}

          {can("machine") && (
            <>
              <div className={styles.row} style={{ marginTop: 10 }}>
                <label className={styles.field}><span className={styles.fieldLabel}>G Z ({g37.GEAR_RANGE.G[0]}–{g37.GEAR_RANGE.G[1]})</span>
                  <Input type="number" value={d(k("g"), m.runG?.toString() ?? "")} onChange={(e) => setD(k("g"), e.target.value)} /></label>
                <label className={styles.field}><span className={styles.fieldLabel}>H Z ({g37.GEAR_RANGE.H[0]}–{g37.GEAR_RANGE.H[1]})</span>
                  <Input type="number" value={d(k("h"), m.runH?.toString() ?? "")} onChange={(e) => setD(k("h"), e.target.value)} /></label>
                <label className={styles.field}><span className={styles.fieldLabel}>{t("Draft (calculé)", "Draft (calculated)")}</span>
                  <Input readOnly value={liveDraft ? nf(liveDraft) : "—"} /></label>
                <Picker label={t("État", "Status")} value={d(k("st"), m.status)} onChange={(v) => setD(k("st"), v)}
                  options={Object.entries(g37.M_STATUS).map(([v, o]) => [v, statusName(v, o.n)])} />
                {d(k("st"), m.status) !== "service" && (
                  <Picker label={t("Motif de l'arrêt", "Stop reason")} value={d(k("r"), m.stopReason ?? g37.STOP_REASONS[0])} onChange={(v) => setD(k("r"), v)}
                    options={g37.STOP_REASONS.map((r) => [r, stopReasonName(r) ?? r])} />
                )}
              </div>
              <div className={styles.row} style={{ marginTop: 10 }}>
                <Button disabled={isSaving} onClick={() => {
                  const st = d(k("st"), m.status) as "service" | "arret" | "maintenance";
                  const gv = d(k("g"), m.runG?.toString() ?? "");
                  const hv = d(k("h"), m.runH?.toString() ?? "");
                  save({
                    action: "machine", no,
                    runG: gv === "" ? null : Number(gv),
                    runH: hv === "" ? null : Number(hv),
                    status: st,
                    stopReason: st === "service" ? null : d(k("r"), m.stopReason ?? g37.STOP_REASONS[0]),
                    stoppedSince: st === "service" ? null : (m.stoppedSince ?? new Date()),
                  });
                }}>{t("Enregistrer les relevés", "Save readings")}</Button>
                {can("eff") && (
                  <>
                    <label className={styles.field} style={{ maxWidth: 150 }}><span className={styles.fieldLabel}>{t("Efficacité %", "Efficiency %")}</span>
                      <Input type="number" step="0.1" value={d(k("e"), eff?.value ?? "")} onChange={(e) => setD(k("e"), e.target.value)} /></label>
                    <Button variant="outline" disabled={isSaving} onClick={() => {
                      const v = d(k("e"), eff?.value ?? "");
                      if (v !== "") save({ action: "eff", machineNo: no, month: monthKey(), value: Number(v) });
                    }}>{t("Enregistrer", "Save")}</Button>
                  </>
                )}
              </div>
              <div className={styles.note} style={{ marginTop: 8 }}>
                {t(`Un métier porte ${g37.GEARS_PER_MACHINE} pignons G et ${g37.GEARS_PER_MACHINE} pignons H. Si tu changes G Z ou H Z, les ${g37.GEARS_PER_MACHINE} pignons déposés retournent au magasin et ${g37.GEARS_PER_MACHINE} du nouveau en sortent, sous ton nom.`,
                  `A machine carries ${g37.GEARS_PER_MACHINE} G gears and ${g37.GEARS_PER_MACHINE} H gears. If you change G Z or H Z, the ${g37.GEARS_PER_MACHINE} removed gears go back to the store and ${g37.GEARS_PER_MACHINE} of the new size are taken out, under your name.`)}
              </div>
            </>
          )}
        </div>

        <div className={styles.two}>
          <div className={styles.card}>
            <span className={styles.eyebrow}>{t("Prochaine maintenance", "Next maintenance")}</span>
            <h2 className={styles.h2} style={{ margin: "4px 0" }}>{m.nextMaintenance ? fmtDate(m.nextMaintenance) : t("non planifiée", "not scheduled")}</h2>
            {m.nextMaintenance && <Pill tone={dueTone(daysTo(dayISO(m.nextMaintenance)))}>{dueText(daysTo(dayISO(m.nextMaintenance)))}</Pill>}
            <div className={styles.meta} style={{ marginTop: 6 }}>{t("Dernière", "Last")} : {fmtDate(m.lastMaintenance)}</div>
          </div>
          <div className={styles.card}>
            <span className={styles.eyebrow}>{t("Historique graissage", "Greasing history")}</span>
            <div className={styles.tableWrap}>
              <table className={styles.table}><tbody>
                {g37.GREASE_POINTS.map((p) => {
                  const h = cycleHistory("grease", no, p.k);
                  return (
                    <tr key={p.k}>
                      <th>{p.n}<div className={styles.meta}>{g37.cycleDays("grease", p.k, no)} {t("j", "d")}</div></th>
                      <td className={styles.num}>{h.length ? h.map((r, i) => <div key={i}>{fmtDate(r.doneOn)} <span className={styles.meta}>{r.authorName}</span></div>) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody></table>
            </div>
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.head}><h2 className={styles.h2}>{t("Travaux effectués", "Work done")}</h2><p className={styles.sub}>{works.length}</p></div>
          {can("works") && (
            <div className={styles.row} style={{ marginBottom: 10 }}>
              <label className={styles.field}><span className={styles.fieldLabel}>{t("Travail", "Work")}</span>
                <Input value={d(k("w"))} onChange={(e) => setD(k("w"), e.target.value)} placeholder={t("Ex. Remplacement manchon avant broche 212", "E.g. Front sleeve replacement spindle 212")} /></label>
              <Button disabled={isSaving || !d(k("w")).trim()} onClick={() => {
                save({ action: "workAdd", machineNo: no, title: d(k("w")).trim(), status: "done" });
                setD(k("w"), "");
              }}>{t("Ajouter", "Add")}</Button>
            </div>
          )}
          {works.length ? works.map((w) => (
            <div key={w.id} className={styles.item}>
              <strong>{w.title}</strong>{" "}
              <Pill tone={w.status === "todo" ? "warn" : "ok"}>{w.status === "todo" ? t("à faire", "to do") : t("effectué", "done")}</Pill>
              {w.auto && <Pill tone="accent">{t("pignons", "gears")}</Pill>}
              <div className={styles.meta}>{w.authorName} · {fmtDate(w.createdAt)}</div>
              {w.status === "todo" && can("works") && (
                <Button variant="outline" size="sm" style={{ marginTop: 6 }} onClick={() => save({ action: "workDone", id: w.id })}>{t("Marquer effectué", "Mark as done")}</Button>
              )}
            </div>
          )) : <div className={styles.empty}>{t("Aucun travail enregistré.", "No work recorded.")}</div>}
        </div>

        <div className={styles.card}>
          <div className={styles.head}><h2 className={styles.h2}>{t("Réglages du groupe", "Group settings")} {grp.id}</h2>
            <p className={styles.sub}>{state.specs.find((s) => s.groupId === grp.id) ? t("modifiés", "modified") : t("manuel technique V5", "technical manual V5")}</p>
            {can("specs") && <Button variant="outline" size="sm" onClick={() => setEditSpecs(!editSpecs)}>{editSpecs ? t("Annuler", "Cancel") : t("Modifier", "Edit")}</Button>}
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}><tbody>
              {g37.SPEC_LABELS.map(([key, label]) => (
                <tr key={key}>
                  <th style={{ width: "46%" }}>{specLabel(label)}</th>
                  <td className={styles.num}>
                    {editSpecs && can("specs")
                      ? <Input value={d(`sp.${grp.id}.${key}`, String(sp[key]))} onChange={(e) => setD(`sp.${grp.id}.${key}`, e.target.value)} />
                      : String(sp[key])}
                  </td>
                </tr>
              ))}
            </tbody></table>
          </div>
          {editSpecs && can("specs") && (
            <div className={styles.row} style={{ marginTop: 10 }}>
              <Button disabled={isSaving} onClick={() => {
                const fields: Record<string, string> = {};
                g37.SPEC_LABELS.forEach(([key]) => { fields[key] = d(`sp.${grp.id}.${key}`, String(sp[key])); });
                save({ action: "specsSet", groupId: grp.id, fields });
                setEditSpecs(false);
              }}>{t("Enregistrer pour tout le groupe", "Save for the whole group")} {grp.id}</Button>
              <Button variant="outline" onClick={() => { save({ action: "specsReset", groupId: grp.id }); setEditSpecs(false); }}>{t("Revenir au manuel", "Back to manual values")}</Button>
            </div>
          )}
        </div>
      </div>
    );
  };

  /* ---------- Gears ---------- */
  const renderGears = () => (
    <div className={styles.stack}>
      <div className={styles.head}><h1 className={styles.title}>Gears</h1><p className={styles.sub}>{t("Stock magasin, pignons montés et total possédé", "Store stock, mounted gears and total owned")}</p></div>
      <div className={styles.note}>
        {t(`Chaque métier porte ${g37.GEARS_PER_MACHINE} pignons G et ${g37.GEARS_PER_MACHINE} pignons H, tous de la même denture. Le stock bouge tout seul au changement du Running G ou H ; le champ ci-dessous ne sert qu'à corriger un écart d'inventaire.`,
          `Each machine carries ${g37.GEARS_PER_MACHINE} G gears and ${g37.GEARS_PER_MACHINE} H gears, all with the same tooth count. Stock moves automatically when Running G or H changes; the field below is only for correcting an inventory gap.`)}
      </div>
      {(["G", "H"] as const).map((type) => {
        const [lo, hi] = g37.GEAR_RANGE[type];
        const rows = [];
        for (let z = lo; z <= hi; z++) rows.push(z);
        const totalStock = rows.reduce((a, z) => a + gearStock(type, z), 0);
        const totalMounted = rows.reduce((a, z) => a + gearMachines(type, z).length * g37.GEARS_PER_MACHINE, 0);
        return (
          <div className={styles.card} key={type}>
            <div className={styles.head}><h2 className={styles.h2}>{t("Pignons", "Gears")} {type}</h2><p className={styles.sub}>Z {lo} → {hi}</p></div>
            <div className={styles.kpis} style={{ marginBottom: 10 }}>
              {kpi(totalStock, t("En stock", "In stock"))}
              {kpi(totalMounted, t("Montés sur machines", "Mounted on machines"))}
              {kpi(totalStock + totalMounted, t("Total possédé", "Total owned"))}
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr>
                  <th>{t("Denture", "Teeth")}</th><th>{t("En stock", "In stock")}</th><th>{t("Montés", "Mounted")} (×{g37.GEARS_PER_MACHINE})</th><th>Total</th><th>{t("Sur quelles M/C", "On which M/C")}</th><th>{t("Jeux", "Sets")}</th>
                  {can("gears") && <th>{t("Corriger", "Correct")}</th>}
                </tr></thead>
                <tbody>
                  {rows.map((z) => {
                    const st = gearStock(type, z);
                    const on = gearMachines(type, z);
                    const mounted = on.length * g37.GEARS_PER_MACHINE;
                    return (
                      <tr key={z}>
                        <td className={styles.num}><strong>Z {z}</strong></td>
                        <td className={styles.num}>{st}</td>
                        <td className={styles.num}>{mounted}{on.length ? ` (${on.length} m/c)` : ""}</td>
                        <td className={styles.num}><strong>{st + mounted}</strong></td>
                        <td className={`${styles.num} ${styles.meta}`}>{on.length ? on.map((n) => `M/C ${n}`).join(", ") : "—"}</td>
                        <td>{st === 0 && mounted === 0 ? <span className={styles.meta}>—</span>
                          : st === 0 ? <Pill tone="crit">{t("rien en stock", "none in stock")}</Pill>
                          : st < g37.GEARS_PER_MACHINE ? <Pill tone="warn">{t("moins d'un jeu", "less than one set")}</Pill>
                          : <Pill tone="ok">{Math.floor(st / g37.GEARS_PER_MACHINE)} {t(`jeu${st >= 2 * g37.GEARS_PER_MACHINE ? "x" : ""}`, `set${st >= 2 * g37.GEARS_PER_MACHINE ? "s" : ""}`)}</Pill>}</td>
                        {can("gears") && (
                          <td>
                            <div className={styles.row} style={{ gap: 4 }}>
                              <Input className={styles.gearInput} type="number" min="0"
                                value={d(`gear.${type}.${z}`, String(st))}
                                onChange={(e) => setD(`gear.${type}.${z}`, e.target.value)} />
                              <Button size="sm" variant="outline" disabled={isSaving}
                                onClick={() => save({ action: "gearStock", gearType: type, teeth: z, stock: Math.max(0, Math.round(Number(d(`gear.${type}.${z}`, String(st))) || 0)) })}>OK</Button>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );

  /* ---------- Travaux ---------- */
  const renderTravaux = () => {
    const list = (state.works ?? []).filter((w) => {
      if (d("wf.m") && w.machineNo !== Number(d("wf.m"))) return false;
      if (d("wf.s") && w.status !== d("wf.s")) return false;
      if (d("wf.t") === "auto" && !w.auto) return false;
      if (d("wf.t") === "main" && w.auto) return false;
      return true;
    });
    const perPerson: Record<string, number> = {};
    (state.works ?? []).filter((w) => dayISO(w.createdAt).slice(0, 7) === monthKey())
      .forEach((w) => { const n = w.authorName ?? "—"; perPerson[n] = (perPerson[n] ?? 0) + 1; });

    return (
      <div className={styles.stack}>
        <div className={styles.head}><h1 className={styles.title}>{t("Travaux", "Work")}</h1><p className={styles.sub}>{t("Toutes machines confondues", "All machines together")}</p></div>
        <div className={styles.kpis}>
          {kpi(todoWorks.length, t("À faire", "To do"), todoWorks.length ? "warn" : "ok")}
          {kpi((state.works ?? []).filter((w) => dayISO(w.createdAt).slice(0, 7) === monthKey()).length, t("Ce mois", "This month"))}
          {kpi((state.works ?? []).length, t("Dans l'historique", "In history"))}
        </div>
        {can("works") && (
          <div className={styles.card}>
            <div className={styles.head}><h2 className={styles.h2}>{t("Ajouter un travail", "Add work")}</h2></div>
            <div className={styles.row}>
              <Picker label="Machine" value={d("wa.m", "1")} onChange={(v) => setD("wa.m", v)}
                options={machines.map((m) => [String(m.no), `M/C ${m.no}`])} />
              <Picker label={t("Travail prédéfini", "Predefined work")} value={d("wa.p", "__custom")} onChange={(v) => {
                setD("wa.p", v);
                if (v !== "__custom") {
                  const item = (state.stock ?? []).find((s) => s.id === v);
                  if (item) setD("wa.t", t(`Changement de ${item.name}`, `Replacement of ${item.name}`));
                }
              }} options={([["__custom", t("Saisie libre", "Free text")]] as Array<[string, string]>).concat((state.stock ?? []).map((s) => [s.id, t(`Changement de ${s.name}`, `Replacement of ${s.name}`)] as [string, string]))} />
              <label className={styles.field}><span className={styles.fieldLabel}>{t("Travail", "Work")}</span>
                <Input value={d("wa.t")} onChange={(e) => setD("wa.t", e.target.value)} /></label>
              <Picker label={t("État", "Status")} value={d("wa.s", "done")} onChange={(v) => setD("wa.s", v)}
                options={[["done", t("Effectué", "Done")], ["todo", t("À faire", "To do")]]} />
              <Button disabled={isSaving || !d("wa.t").trim()} onClick={() => {
                save({ action: "workAdd", machineNo: Number(d("wa.m", "1")), title: d("wa.t").trim(), status: d("wa.s", "done") as "todo" | "done" });
                setD("wa.t", "");
              }}>{t("Ajouter", "Add")}</Button>
            </div>
          </div>
        )}
        <div className={styles.card}>
          <div className={styles.row}>
            <Picker label="Machine" value={d("wf.m", "__all")} onChange={(v) => setD("wf.m", v === "__all" ? "" : v)}
              options={[["__all", t("Toutes", "All")] as [string, string]].concat(machines.map((m) => [String(m.no), `M/C ${m.no}`] as [string, string]))} />
            <Picker label={t("État", "Status")} value={d("wf.s", "__all")} onChange={(v) => setD("wf.s", v === "__all" ? "" : v)}
              options={[["__all", t("Tous", "All")], ["todo", t("À faire", "To do")], ["done", t("Effectués", "Done")]]} />
            <Picker label="Type" value={d("wf.t", "__all")} onChange={(v) => setD("wf.t", v === "__all" ? "" : v)}
              options={[["__all", t("Tous", "All")], ["main", t("Saisis à la main", "Entered manually")], ["auto", t("Changements de pignons", "Gear changes")]]} />
          </div>
        </div>
        <div className={styles.card}>
          <div className={styles.head}><h2 className={styles.h2}>{list.length} {t("travaux", "work items")}</h2></div>
          {list.length ? list.slice(0, 120).map((w) => (
            <div key={w.id} className={styles.item}>
              <div className={`${styles.row} ${styles.between}`}>
                <strong>{w.title}</strong>
                <span className={styles.row} style={{ gap: 4 }}>
                  <Pill tone="accent">M/C {w.machineNo}</Pill>
                  <Pill tone={w.status === "todo" ? "warn" : "ok"}>{w.status === "todo" ? t("à faire", "to do") : t("effectué", "done")}</Pill>
                  {w.auto && <Pill>{t("pignons", "gears")}</Pill>}
                </span>
              </div>
              <div className={styles.meta}>{w.authorName} · {fmtDate(w.createdAt)}{w.doneByName ? ` · ${t("clôturé par", "closed by")} ${w.doneByName}` : ""}</div>
              {w.status === "todo" && can("works") && (
                <Button variant="outline" size="sm" style={{ marginTop: 6 }} onClick={() => save({ action: "workDone", id: w.id })}>{t("Marquer effectué", "Mark as done")}</Button>
              )}
            </div>
          )) : <div className={styles.empty}>{t("Aucun travail ne correspond à ces filtres.", "No work matches these filters.")}</div>}
        </div>
        {Object.keys(perPerson).length > 0 && (
          <div className={styles.card}>
            <div className={styles.head}><h2 className={styles.h2}>{t("Qui a fait quoi en", "Who did what in")} {MONTHS()[new Date().getMonth()]}</h2></div>
            {Object.entries(perPerson).sort((a, b) => b[1] - a[1]).map(([n, c]) => (
              <div key={n} className={`${styles.item} ${styles.row} ${styles.between}`}><strong>{n}</strong><Pill tone="accent">{c}</Pill></div>
            ))}
          </div>
        )}
      </div>
    );
  };

  /* ---------- Maintenance ---------- */
  const generateMaintenancePdf = async () => {
    setPdfBusy(true);
    try {
      const pdf = await PDFDocument.create();
      pdf.setTitle(t("Rapport de maintenance G37", "G37 maintenance report"));
      pdf.setAuthor(me.displayName);
      const regular = await pdf.embedFont(StandardFonts.Helvetica);
      const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
      // Helvetica ne connaît pas tous les caractères (flèches, etc.) : on les remplace.
      const clean = (s: string) => s.replace(/→/g, "->").replace(/←/g, "<-").replace(/[^\x00-\xFF\u2013\u2014\u2026\u2018\u2019\u201C\u201D]/g, "?");
      const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

      const W = 595.28, H = 841.89, L = 36, R = W - 36, BOTTOM = 56;
      let page = pdf.addPage([W, H]);
      let y = H - 42;
      let pageNo = 1;
      const footer = () => {
        page.drawText(clean(`${t("Page", "Page")} ${pageNo} · ${t("Généré le", "Generated on")} ${fmtDate(todayISO())} ${t("par", "by")} ${me.displayName}`), { x: L, y: 28, size: 7.5, font: regular });
      };
      const newPage = () => { footer(); page = pdf.addPage([W, H]); pageNo += 1; y = H - 42; };
      const need = (h: number) => { if (y - h < BOTTOM) newPage(); };
      const text = (s: string, x: number, size: number, font = regular) => page.drawText(clean(s), { x, y, size, font });
      const line = () => { page.drawLine({ start: { x: L, y: y + 4 }, end: { x: R, y: y + 4 }, thickness: 0.5 }); };

      // En-tête
      text(t("RAPPORT DE MAINTENANCE ET TRAVAUX — G37 / RIETER", "MAINTENANCE AND WORK REPORT — G37 / RIETER"), L, 15, bold);
      y -= 20;
      const allMaint = state.maintenance ?? [];
      const allWorks = (state.works ?? []).filter((w) => w.status === "done");
      const maintained = machines.filter((m) => m.lastMaintenance).length;
      text(t(`${machines.length} machines · ${allMaint.length} interventions de maintenance · ${allWorks.length} travaux effectués`,
        `${machines.length} machines · ${allMaint.length} maintenance interventions · ${allWorks.length} work items done`), L, 9);
      y -= 13;
      text(t(`${maintained}/${machines.length} machines ont une dernière maintenance enregistrée.`,
        `${maintained}/${machines.length} machines have a recorded last maintenance.`), L, 9);
      y -= 24;

      // Une section par machine : état, maintenances, puis travaux effectués.
      machines.forEach((m) => {
        const maint = allMaint.filter((r) => r.machineNo === m.no).slice().sort((a, b) => new Date(b.performedAt).getTime() - new Date(a.performedAt).getTime());
        const works = allWorks.filter((w) => w.machineNo === m.no).slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        need(60);
        line();
        y -= 10;
        text(`M/C ${m.no}`, L, 11, bold);
        text(`${statusName(m.status, g37.M_STATUS[m.status]?.n ?? m.status)}${m.stopReason ? ` · ${stopReasonName(m.stopReason)}` : ""}`, L + 60, 8.5);
        y -= 13;
        text(`${t("Dernière maintenance", "Last maintenance")} : ${fmtDate(m.lastMaintenance)}   ·   ${t("Prochaine", "Next")} : ${fmtDate(m.nextMaintenance)}   ·   G Z ${m.runG ?? "—"} / H Z ${m.runH ?? "—"}`, L, 8);
        y -= 15;

        // Maintenances
        text(t("Maintenances", "Maintenance"), L, 8.5, bold);
        text(`${maint.length}`, L + 70, 8.5);
        y -= 12;
        if (maint.length === 0) {
          text(t("Aucune intervention enregistrée.", "No intervention recorded."), L + 10, 7.5);
          y -= 11;
        } else {
          const xs = [L + 10, L + 80, L + 330, L + 410];
          [t("Date", "Date"), t("Maintenance", "Maintenance"), t("Prochaine", "Next due"), t("Technicien", "Technician")].forEach((h, i) => text(h, xs[i], 7.5, bold));
          y -= 11;
          maint.forEach((r) => {
            need(12);
            [fmtDate(r.performedAt), cut(r.maintenanceType, 48), fmtDate(r.nextDue), cut(r.technician ?? "—", 22)].forEach((v, i) => text(v, xs[i], 7.5));
            y -= 11;
          });
        }
        y -= 5;

        // Travaux effectués
        need(24);
        text(t("Travaux effectués", "Work done"), L, 8.5, bold);
        text(`${works.length}`, L + 80, 8.5);
        y -= 12;
        if (works.length === 0) {
          text(t("Aucun travail effectué.", "No work done."), L + 10, 7.5);
          y -= 11;
        } else {
          const xs = [L + 10, L + 80, L + 380];
          [t("Date", "Date"), t("Travail", "Work"), t("Par", "By")].forEach((h, i) => text(h, xs[i], 7.5, bold));
          y -= 11;
          works.forEach((w) => {
            need(12);
            const who = w.doneByName ?? w.authorName ?? "—";
            [fmtDate(w.createdAt), cut(`${w.title}${w.auto ? ` (${t("pignons", "gears")})` : ""}`, 58), cut(who, 26)].forEach((v, i) => text(v, xs[i], 7.5));
            y -= 11;
          });
        }
        y -= 12;
      });
      footer();

      const bytes = await pdf.save();
      await saveBlob(new Blob([bytes as BlobPart], { type: "application/pdf" }), `${t("rapport-maintenance-travaux-g37", "maintenance-work-report-g37")}-${todayISO()}.pdf`);
      toast.success(t("Rapport PDF généré.", "PDF report generated."));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Impossible de générer le PDF.", "Unable to generate the PDF."));
    } finally {
      setPdfBusy(false);
    }
  };

  const renderMaintenance = () => (
    <div className={styles.stack}>
      <div className={styles.head}>
        <div><h1 className={styles.title}>Maintenance</h1><p className={styles.sub}>{t("Planning des", "Schedule of the")} {machines.length} {t("métiers", "machines")}</p></div>
        <Button variant="outline" disabled={pdfBusy} onClick={generateMaintenancePdf}>{pdfBusy ? t("Génération…", "Generating…") : t("📄 Rapport PDF", "📄 PDF report")}</Button>
      </div>
      {!can("maint") && <div className={styles.note}>{t("Lecture seule. Seuls l'admin, le superviseur, le technicien et le responsable maintenance modifient ce planning.", "Read only. Only the admin, supervisor, technician and maintenance manager can edit this schedule.")}</div>}
      <div className={styles.card}>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Machine</th><th>{t("Dernière", "Last")}</th><th>{t("Prochaine", "Next")}</th><th>{t("Échéance", "Due")}</th>{can("maint") && <th>Action</th>}</tr></thead>
            <tbody>
              {machines.map((m) => {
                const n = m.nextMaintenance ? daysTo(dayISO(m.nextMaintenance)) : null;
                return (
                  <tr key={m.no}>
                    <td className={styles.num}><strong>M/C {m.no}</strong></td>
                    <td className={styles.num}>{fmtDate(m.lastMaintenance)}</td>
                    <td className={styles.num}>{fmtDate(m.nextMaintenance)}</td>
                    <td>{n == null ? <Pill>{t("à planifier", "to schedule")}</Pill> : <Pill tone={dueTone(n)}>{dueText(n)}</Pill>}</td>
                    {can("maint") && (
                      <td>
                        <div className={styles.row} style={{ gap: 4 }}>
                          <Input type="date" value={d(`mt.${m.no}`, m.nextMaintenance ? dayISO(m.nextMaintenance) : "")}
                            onChange={(e) => { setD(`mt.${m.no}`, e.target.value); save({ action: "maintPlan", machineNo: m.no, next: e.target.value ? new Date(e.target.value + "T00:00:00Z") : null }); }} />
                          <Button size="sm" variant="outline" disabled={isSaving} onClick={() => save({ action: "maintDone", machineNo: m.no })}>{t("Faite", "Done")}</Button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );

  /* ---------- Graissage / Lubrification ---------- */
  const renderCycle = (kind: "grease" | "lub" | "sched") => {
    const defs = pointsOf(kind);
    const canDo = kind === "sched" ? can("works") : can("grease");
    const todayStr = new Date().toISOString().slice(0, 10);
    const dLabel = (n: number) => n === 365 ? t("1 an", "1 year") : `${n} ${t("j", "d")}`;
    const exceptions = kind === "sched" ? [] : g37.CYCLE_OVERRIDES.filter((x) => x.kind === kind);
    return (
      <div className={styles.stack}>
        <div className={styles.head}>
          <h1 className={styles.title}>{kind === "grease" ? t("Graissage", "Greasing") : kind === "lub" ? t("Lubrification", "Lubrication") : "Schedule works"}</h1>
          <p className={styles.sub}>{defs.map((x) => `${x.n} · ${dLabel(x.d)}`).join(" — ")}</p>
        </div>
        {exceptions.length > 0 && (
          <div className={styles.note}>
            <strong>{t("Exceptions :", "Exceptions:")}</strong>{" "}
            {exceptions.map((x) => t(`${defs.find((dd) => dd.k === x.point)?.n} toutes les ${x.d} j sur les M/C ${x.from} à ${x.to}`, `${defs.find((dd) => dd.k === x.point)?.n} every ${x.d} d on M/C ${x.from} to ${x.to}`)).join(" · ")}
          </div>
        )}
        {canDo ? (
          <div className={styles.card}>
            <div className={styles.head}><h2 className={styles.h2}>{kind === "sched" ? t("Enregistrer un travail", "Record a work") : t("Tournée", "Round")}</h2><p className={styles.sub}>{t("Enregistre d'un coup sur une série de machines", "Record at once on a range of machines")}</p></div>
            <div className={styles.row}>
              <Picker label={kind === "sched" ? t("Travail", "Work") : "Point"} value={d(`cy.${kind}.p`, "__all")} onChange={(v) => setD(`cy.${kind}.p`, v)}
                options={[["__all", kind === "sched" ? t("Tous les travaux", "All works") : t("Tous les points", "All points")] as [string, string]].concat(defs.map((p) => [p.k, p.n] as [string, string]))} />
              <label className={styles.field} style={{ maxWidth: 110 }}><span className={styles.fieldLabel}>{t("De la M/C", "From M/C")}</span>
                <Input type="number" min="1" max="28" value={d(`cy.${kind}.a`, "1")} onChange={(e) => setD(`cy.${kind}.a`, e.target.value)} /></label>
              <label className={styles.field} style={{ maxWidth: 110 }}><span className={styles.fieldLabel}>{t("À la M/C", "To M/C")}</span>
                <Input type="number" min="1" max="28" value={d(`cy.${kind}.b`, "28")} onChange={(e) => setD(`cy.${kind}.b`, e.target.value)} /></label>
              <Button disabled={isSaving} onClick={() => save({
                action: "cycle", kind, pointKey: d(`cy.${kind}.p`, "__all"),
                from: Number(d(`cy.${kind}.a`, "1")), to: Number(d(`cy.${kind}.b`, "28")),
              })}>{t("Enregistrer la tournée", "Record the round")}</Button>
            </div>
            <div className={styles.note} style={{ marginTop: 8 }}>{t("Les opérations sont datées d'aujourd'hui et portent ton nom.", "Operations are dated today and carry your name.")}</div>
          </div>
        ) : <div className={styles.note}>{t("Lecture seule.", "Read only.")}</div>}

        <div className={styles.card}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Machine</th>{defs.map((p) => {
                const ov = g37.CYCLE_OVERRIDES.filter((x) => x.kind === kind && x.point === p.k);
                return <th key={p.k}>{p.n}<br /><span style={{ textTransform: "none", letterSpacing: 0 }}>{p.d === 365 ? t("1 an", "1 year") : `${p.d} ${t("j", "d")}`}{ov.map((x) => ` · ${x.d} ${t("j", "d")} M/C ${x.from}-${x.to}`).join("")}</span></th>;
              })}</tr></thead>
              <tbody>
                {machines.map((m) => (
                  <tr key={m.no}>
                    <td className={styles.num}><strong>M/C {m.no}</strong></td>
                    {defs.map((p) => {
                      const last = lastCycle.get(`${kind}:${m.no}:${p.k}`);
                      const dd = daysFor(kind, p, m.no);
                      const n = last ? daysTo(addDays(last.doneOn, dd)) : null;
                      return (
                        <td key={p.k}>
                          <Pill tone={dueTone(n)}>{last ? dueText(n) : t("jamais", "never")}</Pill>
                          {dd !== p.d && <div className={styles.meta}><strong>{dd} {t("j", "d")}</strong></div>}
                          {canDo ? (
                            <Input key={`${kind}-${m.no}-${p.k}-${last?.doneOn ?? ""}`} type="date" max={todayStr} defaultValue={last?.doneOn ?? ""} disabled={isSaving}
                              style={{ marginTop: 4, minWidth: 128 }}
                              onChange={(e) => { if (e.target.value) save({ action: "cycleDate", kind, pointKey: p.k, machineNo: m.no, date: e.target.value }); }} />
                          ) : <div className={`${styles.meta} ${styles.num}`}>{last ? fmtDate(last.doneOn) : "—"}</div>}
                          {canDo && (
                            <Button size="sm" variant="outline" style={{ marginTop: 4 }} disabled={isSaving}
                              onClick={() => save({ action: "cycle", kind, pointKey: p.k, from: m.no, to: m.no })}>{t("Fait", "Done")}</Button>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {canDo && (
          <div className={styles.card}>
            <div className={styles.head}>
              <h2 className={styles.h2}>{kind === "sched" ? t("Gérer les travaux", "Manage works") : t("Gérer les types", "Manage types")}</h2>
              <p className={styles.sub}>{t("Ajoute un nouveau type ou modifie son nom et sa périodicité (en jours).", "Add a new type or edit its name and interval (in days).")}</p>
            </div>
            <div className={styles.row}>
              <label className={styles.field}><span className={styles.fieldLabel}>{t("Nom", "Name")}</span>
                <Input value={d(`cp.${kind}.n`)} onChange={(e) => setD(`cp.${kind}.n`, e.target.value)} placeholder={kind === "sched" ? "Ex. Doffer height settings" : t("Ex. Chaîne d'entraînement", "E.g. Drive chain")} /></label>
              <label className={styles.field} style={{ maxWidth: 130 }}><span className={styles.fieldLabel}>{t("Tous les (jours)", "Every (days)")}</span>
                <Input type="number" min="1" max="3650" value={d(`cp.${kind}.d`, "30")} onChange={(e) => setD(`cp.${kind}.d`, e.target.value)} /></label>
              <Button disabled={isSaving || !d(`cp.${kind}.n`).trim()} onClick={() => {
                save({ action: "cyclePointAdd", kind, name: d(`cp.${kind}.n`).trim(), days: Math.min(3650, Math.max(1, Math.round(Number(d(`cp.${kind}.d`, "30")) || 30))) });
                setD(`cp.${kind}.n`, "");
              }}>{t("Ajouter", "Add")}</Button>
            </div>
            {defs.filter((p) => p.id).map((p) => (
              <div key={p.id} className={styles.row} style={{ marginTop: 8 }}>
                <Input value={d(`cpe.${p.id}.n`, p.n)} onChange={(e) => setD(`cpe.${p.id}.n`, e.target.value)} />
                <Input type="number" min="1" max="3650" style={{ maxWidth: 110 }} value={d(`cpe.${p.id}.d`, String(p.d))} onChange={(e) => setD(`cpe.${p.id}.d`, e.target.value)} />
                <Button size="sm" variant="outline" disabled={isSaving || !d(`cpe.${p.id}.n`, p.n).trim()} onClick={() => save({
                  action: "cyclePointEdit", id: p.id as string, name: d(`cpe.${p.id}.n`, p.n).trim(),
                  days: Math.min(3650, Math.max(1, Math.round(Number(d(`cpe.${p.id}.d`, String(p.d))) || p.d))),
                })}>{t("Modifier", "Save")}</Button>
                <Button size="sm" variant="outline" disabled={isSaving} onClick={() => {
                  if (window.confirm(t(`Supprimer « ${p.n} » ?`, `Delete "${p.n}"?`))) save({ action: "cyclePointDelete", id: p.id as string });
                }}>{t("Supprimer", "Delete")}</Button>
              </div>
            ))}
            {kind !== "sched" && <div className={styles.note} style={{ marginTop: 8 }}>{t("Les points d'origine restent fixes ; seuls les types ajoutés se modifient.", "Built-in points stay fixed; only added types can be edited.")}</div>}
          </div>
        )}
      </div>
    );
  };

  /* ---------- Pannes ---------- */
  const renderPannes = () => {
    const selected = Number(d("fa.m", "1"));
    const dupes = openFaults.filter((f) => f.machineNo === selected);
    const resolved = (state.failures ?? []).filter((f) => f.status === "resolue");
    const faultCard = (f: typeof state.failures[number]) => (
      <div key={f.id} className={styles.item}>
        <div className={`${styles.row} ${styles.between}`}>
          <strong>M/C {f.machineNo} — {f.issue}</strong>
          <Pill tone={f.status === "resolue" ? "ok" : "crit"}>{f.status === "resolue" ? t("réglée", "fixed") : t("ouverte", "open")}</Pill>
        </div>
        {f.notes && <div>{f.notes}</div>}
        <div className={styles.meta}>
          {t("Signalée par", "Reported by")} {f.reportedBy ?? "—"} {t("le", "on")} {fmtDate(f.openedAt)}
          {f.fixedBy ? ` · ${t("réglée par", "fixed by")} ${f.fixedBy} ${t("le", "on")} ${fmtDate(f.resolvedAt)}` : ""}
        </div>
        {f.stoppedAt && (
          <div className={styles.row} style={{ marginTop: 4 }}>
            {f.restartedAt
              ? <Pill tone="warn">{t("arrêt", "stopped")} {fmtDur(f.stoppedAt, f.restartedAt)}</Pill>
              : <Pill tone="crit">{t("arrêtée depuis", "stopped for")} {fmtDur(f.stoppedAt, new Date()) ?? t("peu", "a moment")}</Pill>}
          </div>
        )}
        {f.status !== "resolue" && can("faults") && (
          <div className={styles.row} style={{ marginTop: 6 }}>
            <Input placeholder={t("Ce qui a été fait", "What was done")} value={d(`fx.${f.id}`)} onChange={(e) => setD(`fx.${f.id}`, e.target.value)} />
            <Button size="sm" disabled={isSaving} onClick={() => save({
              action: "faultFix", id: f.id, fix: d(`fx.${f.id}`).trim() || null,
              restartedAt: f.stoppedAt ? new Date() : null,
            })}>{t("Marquer réglée", "Mark as fixed")}</Button>
          </div>
        )}
      </div>
    );

    return (
      <div className={styles.stack}>
        <div className={styles.head}><h1 className={styles.title}>{t("Pannes", "Faults")}</h1><p className={styles.sub}>{t("Historique complet", "Full history")}</p></div>
        {can("faultReport") && (
          <div className={styles.card}>
            <div className={styles.head}><h2 className={styles.h2}>{t("Signaler une panne", "Report a fault")}</h2><p className={styles.sub}>{t("Choisis dans la liste courante ou écris la tienne", "Pick from the common list or write your own")}</p></div>
            <div className={styles.row}>
              <Picker label="Machine" value={d("fa.m", "1")} onChange={(v) => setD("fa.m", v)}
                options={machines.map((m) => [String(m.no), `M/C ${m.no}`])} />
              <Picker label={t("Panne", "Fault")} value={d("fa.c", "__autre")} onChange={(v) => setD("fa.c", v)}
                options={g37.COMMON_FAULTS.concat((state.stockNames ?? []).map((n) => `${t("Problème de", "Problem with")} ${n}`)).map((f) => [f, f] as [string, string]).concat([["__autre", t("Autre (à écrire)", "Other (write it)")]])} />
              <Picker label={t("Gravité", "Severity")} value={d("fa.sev", "moyenne")} onChange={(v) => setD("fa.sev", v)}
                options={[["basse", t("Basse", "Low")], ["moyenne", t("Moyenne", "Medium")], ["haute", t("Haute", "High")]]} />
            </div>
            {d("fa.c", "__autre") === "__autre" && (
              <label className={styles.field} style={{ marginTop: 8 }}><span className={styles.fieldLabel}>{t("Préciser la panne", "Describe the fault")}</span>
                <Input value={d("fa.t")} onChange={(e) => setD("fa.t", e.target.value)} /></label>
            )}
            <label className={styles.field} style={{ marginTop: 8 }}><span className={styles.fieldLabel}>{t("Détail", "Details")}</span>
              <Input value={d("fa.d")} onChange={(e) => setD("fa.d", e.target.value)} placeholder={t("Symptômes, broche concernée…", "Symptoms, spindle concerned…")} /></label>
            <div className={styles.row} style={{ marginTop: 10 }}>
              <Button disabled={isSaving} onClick={() => {
                const choice = d("fa.c", "__autre");
                const title = choice === "__autre" ? d("fa.t").trim() : choice;
                if (!title) return;
                save({
                  action: "faultAdd", machineNo: Number(d("fa.m", "1")), issue: title,
                  notes: d("fa.d").trim() || null,
                  severity: d("fa.sev", "moyenne") as "basse" | "moyenne" | "haute",
                  stoppedAt: new Date(),
                });
                setD("fa.t", ""); setD("fa.d", "");
              }}>{t("Enregistrer la panne", "Record the fault")}</Button>
            </div>
            {dupes.length > 0 && (
              <div className={styles.note} style={{ marginTop: 10 }}>
                <strong>{t("Déjà signalé :", "Already reported:")}</strong> {t(`${dupes.length} panne${plural(dupes.length)} encore ouverte${plural(dupes.length)} sur la M/C ${selected}.`, `${dupes.length} fault${plural(dupes.length)} still open on M/C ${selected}.`)}
                {dupes.map((f) => <div key={f.id}>· {f.issue} — {f.reportedBy}, {fmtDate(f.openedAt)}</div>)}
              </div>
            )}
          </div>
        )}
        <div className={styles.card}>
          <div className={styles.head}><h2 className={styles.h2}>{t("Ouvertes", "Open")}</h2><p className={styles.sub}>{openFaults.length}</p></div>
          {openFaults.length ? openFaults.map(faultCard) : <div className={styles.empty}>{t("Aucune panne ouverte.", "No open fault.")}</div>}
        </div>
        <div className={styles.card}>
          <div className={styles.head}><h2 className={styles.h2}>{t("Réglées", "Fixed")}</h2><p className={styles.sub}>{resolved.length}</p></div>
          {resolved.length ? resolved.slice(0, 40).map(faultCard) : <div className={styles.empty}>{t("L'historique se remplira au fil des interventions.", "History will fill up as interventions happen.")}</div>}
        </div>
      </div>
    );
  };

  /* ---------- Quarts ---------- */
  const renderQuarts = () => {
    const [y, mo] = shiftMonth.split("-").map(Number);
    const nDays = new Date(y, mo, 0).getDate();
    const shiftOf = (day: string, team: string) => state.shifts.find((s) => dayISO(s.day) === day && s.team === team)?.shiftCode ?? "";
    const now = new Date();
    const h = now.getHours();
    const code = h >= 7 && h < 15 ? "m" : h >= 15 && h < 23 ? "s" : "n";
    let dutyDay = todayISO();
    if (h < 7) { const dd = new Date(); dd.setDate(dd.getDate() - 1); dutyDay = dd.toISOString().slice(0, 10); }
    const dutyTeam = g37.TEAMS.find((t) => shiftOf(dutyDay, t) === code);
    const shiftLabel = g37.SHIFT_TYPES.find((s) => s.k === code);

    return (
      <div className={styles.stack}>
        <div className={styles.head}><h1 className={styles.title}>{t("Running techniciens", "Technicians on duty")}</h1><p className={styles.sub}>{t("Planning des quarts · équipes A, B et C", "Shift schedule · teams A, B and C")}</p></div>
        <div className={styles.card}>
          <span className={styles.eyebrow}>{t("En ce moment", "Right now")}</span>
          <h2 className={styles.h2} style={{ margin: "4px 0" }}>{dutyTeam ? `${t("Équipe", "Team")} ${dutyTeam} — ${shiftName(code, shiftLabel?.n ?? "")}` : t("Aucune équipe planifiée", "No team scheduled")}</h2>
          <Pill tone="accent">{shiftLabel?.h}</Pill>
          {dutyTeam && (
            <div className={styles.meta} style={{ marginTop: 6 }}>
              {state.users.filter((u) => u.team === dutyTeam).map((u) => u.displayName).join(", ") || t("Assigne tes techniciens à une équipe depuis l'onglet Accès.", "Assign your technicians to a team from the Access tab.")}
            </div>
          )}
        </div>
        <div className={styles.card}>
          <div className={styles.row}>
            {g37.SHIFT_TYPES.map((s) => <Pill key={s.k}>{shiftName(s.k, s.n)} · {s.h}</Pill>)}
          </div>
        </div>
        <div className={styles.card}>
          <div className={`${styles.row} ${styles.between}`} style={{ marginBottom: 10 }}>
            <label className={styles.field} style={{ maxWidth: 190 }}><span className={styles.fieldLabel}>{t("Mois", "Month")}</span>
              <Input type="month" value={shiftMonth} onChange={(e) => setShiftMonth(e.target.value || monthKey())} /></label>
            {can("shifts") && <Button variant="outline" disabled={isSaving} onClick={() => save({ action: "shiftRotate", month: shiftMonth })}>{t("Remplir par rotation", "Fill by rotation")}</Button>}
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>{t("Jour", "Day")}</th>{g37.TEAMS.map((tm) => <th key={tm}>{t("Équipe", "Team")} {tm}</th>)}</tr></thead>
              <tbody>
                {Array.from({ length: nDays }, (_, i) => {
                  const day = `${shiftMonth}-${String(i + 1).padStart(2, "0")}`;
                  const isToday = day === todayISO();
                  return (
                    <tr key={day} className={isToday ? styles.highlight : undefined}>
                      <td className={styles.num}><strong>{String(i + 1).padStart(2, "0")}</strong></td>
                      {g37.TEAMS.map((t) => {
                        const v = shiftOf(day, t);
                        return (
                          <td key={t}>
                            {can("shifts") ? (
                              <Select value={v || "__none"} onValueChange={(nv) => save({ action: "shiftSet", day, team: t, shiftCode: (nv === "__none" ? "" : nv) as "m" | "s" | "n" | "r" | "" })}>
                                <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none">—</SelectItem>
                                  {g37.SHIFT_TYPES.map((s) => <SelectItem key={s.k} value={s.k}>{shiftName(s.k, s.n)}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            ) : v ? <Pill>{shiftName(v, g37.SHIFT_TYPES.find((s) => s.k === v)?.n ?? v)}</Pill> : <span className={styles.meta}>—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };

  /* ---------- Calcul : count, draft, pignons G / H ---------- */
  const renderCalcul = () => {
    const mode = d("cl.mode", "count") as "count" | "draft" | "gears";
    const useStock = d("cl.stock", "1") === "1";
    const hank = parseNum(d("cl.hank", "0.83"));
    const [gLo, gHi] = g37.GEAR_RANGE.G;
    const [hLo, hHi] = g37.GEAR_RANGE.H;
    const dMin = (g37.DRAFT_K * hLo) / gHi;
    const dMax = (g37.DRAFT_K * hHi) / gLo;
    const full = (type: "G" | "H", z: number) => gearStock(type, z) >= g37.GEARS_PER_MACHINE;

    let target: number | null = null;
    if (mode === "count") {
      const c = parseNum(d("cl.count", "30"));
      if (c && hank && c > 0 && hank > 0) target = c / hank;
    } else if (mode === "draft") {
      const t = parseNum(d("cl.draft", "36.14"));
      if (t && t > 0) target = t;
    }

    const tol = 0.5;
    const pairs: Array<{ G: number; H: number; dr: number; err: number; okG: boolean; okH: boolean }> = [];
    if (target != null) {
      for (let G = gLo; G <= gHi; G++) {
        for (let H = hLo; H <= hHi; H++) {
          const dr = (g37.DRAFT_K * H) / G;
          const err = ((dr - target) / target) * 100;
          if (Math.abs(err) <= tol) pairs.push({ G, H, dr, err, okG: full("G", G), okH: full("H", H) });
        }
      }
      pairs.sort((a, b) =>
        useStock
          ? (Number(b.okG && b.okH) - Number(a.okG && a.okH)) || (Math.abs(a.err) - Math.abs(b.err))
          : Math.abs(a.err) - Math.abs(b.err));
    }
    const mountable = pairs.filter((p) => p.okG && p.okH).length;

    const gIn = parseNum(d("cl.g", "46"));
    const hIn = parseNum(d("cl.h", "104"));
    const gBad = gIn != null && (!Number.isInteger(gIn) || !g37.inGearRange("G", gIn));
    const hBad = hIn != null && (!Number.isInteger(hIn) || !g37.inGearRange("H", hIn));
    const drFromGears = gIn != null && hIn != null && !gBad && !hBad ? g37.draftOf(gIn, hIn) : null;

    // Calcul illimité : les résultats s'affichent en direct.
    const showResults = true;
    const calcBusy = false;
    const runCalc = async () => {};

    return (
      <div className={styles.stack}>
        <div className={styles.head}><h1 className={styles.title}>{t("Calcul", "Calculator")}</h1><p className={styles.sub}>{t("Count, draft et pignons G / H", "Count, draft and G / H gears")}</p>
          {quotaLine("calc") && <p className={styles.meta}>{quotaLine("calc")}</p>}</div>
        <div className={styles.note}>
          Draft = <strong>16,068 × H ÷ G</strong> · Count = <strong>Hank × Draft</strong>
        </div>
        <div className={styles.row}>
          {([["count", t("Count → pignons", "Count → gears")], ["draft", t("Draft → pignons", "Draft → gears")], ["gears", t("Pignons → count", "Gears → count")]] as Array<[string, string]>).map(([key, label]) => (
            <Button key={key} variant={mode === key ? "primary" : "outline"} onClick={() => setD("cl.mode", key)}>{label}</Button>
          ))}
        </div>

        <div className={styles.card}>
          <div className={styles.row}>
            {mode === "count" && (
              <label className={styles.field}><span className={styles.fieldLabel}>{t("Count visé (Ne)", "Target count (Ne)")}</span>
                <Input inputMode="decimal" value={d("cl.count", "30")} onChange={(e) => setD("cl.count", e.target.value)} /></label>
            )}
            {mode === "draft" && (
              <label className={styles.field}><span className={styles.fieldLabel}>{t("Draft total", "Total draft")}</span>
                <Input inputMode="decimal" value={d("cl.draft", "36.14")} onChange={(e) => setD("cl.draft", e.target.value)} /></label>
            )}
            {mode === "gears" && (
              <>
                <label className={styles.field}><span className={styles.fieldLabel}>Gear G ({gLo}–{gHi})</span>
                  <Input inputMode="numeric" value={d("cl.g", "46")} onChange={(e) => setD("cl.g", e.target.value)} /></label>
                <label className={styles.field}><span className={styles.fieldLabel}>Gear H ({hLo}–{hHi})</span>
                  <Input inputMode="numeric" value={d("cl.h", "104")} onChange={(e) => setD("cl.h", e.target.value)} /></label>
              </>
            )}
            <label className={styles.field}><span className={styles.fieldLabel}>{t("Hank mèche (Ne)", "Roving hank (Ne)")}{mode === "count" ? "" : t(" — facultatif", " — optional")}</span>
              <Input inputMode="decimal" value={d("cl.hank", "0.83")} onChange={(e) => setD("cl.hank", e.target.value)} /></label>
          </div>
          {!showResults && (
            <div className={styles.row} style={{ marginTop: 12 }}>
              <Button disabled={calcBusy} onClick={() => void runCalc()}>{calcBusy ? t("Calcul…", "Calculating…") : t("Calculer", "Calculate")}</Button>
            </div>
          )}
        </div>

        {!showResults ? null : mode === "gears" ? (
          <div className={styles.card}>
            <div className={styles.head}><h2 className={styles.h2}>{t("Résultat", "Result")}</h2>
              {gIn != null && hIn != null && <p className={styles.sub}>16,068 × {hIn} ÷ {gIn}</p>}</div>
            <div className={styles.kpis}>
              {kpi(drFromGears ? nf(drFromGears) : "—", t("Draft total", "Total draft"))}
              {kpi(drFromGears && hank ? nf(drFromGears * hank) : "—", t("Count produit (Ne)", "Produced count (Ne)"))}
              {kpi(hank ? nf(hank) : "—", t("Hank mèche (Ne)", "Roving hank (Ne)"))}
            </div>
            {(gBad || hBad) && (
              <div className={`${styles.note} ${styles.toneCrit}`} style={{ marginTop: 8 }}>
                {gBad && <div>{t(`G doit être un entier entre ${gLo} et ${gHi}.`, `G must be an integer between ${gLo} and ${gHi}.`)}</div>}
                {hBad && <div>{t(`H doit être un entier entre ${hLo} et ${hHi}.`, `H must be an integer between ${hLo} and ${hHi}.`)}</div>}
              </div>
            )}
            {drFromGears && hank && (
              <div className={styles.note} style={{ marginTop: 8 }}>
                {t(`Pour retrouver le hank à partir du count réellement produit : Hank = Count ÷ ${nf(drFromGears)}.`, `To get the hank back from the count actually produced: Hank = Count ÷ ${nf(drFromGears)}.`)}
              </div>
            )}
          </div>
        ) : (
          <>
            <div className={styles.card}>
              <div className={styles.head}><h2 className={styles.h2}>{mode === "count" ? t("Étirage nécessaire", "Required draft") : t("Étirage demandé", "Requested draft")}</h2></div>
              <div className={styles.kpis}>
                {kpi(target ? nf(target) : "—", t("Draft total", "Total draft"))}
                {mode === "draft" && kpi(target && hank ? nf(target * hank) : "—", t("Count obtenu (Ne)", "Resulting count (Ne)"))}
              </div>
              {target != null && (target < dMin || target > dMax) && (
                <div className={`${styles.note} ${styles.toneCrit}`} style={{ marginTop: 8 }}>
                  {t(`Étirage hors de portée des dentures : la machine va de ${nf(dMin)} à ${nf(dMax)}.`, `Draft out of gear range: the machine goes from ${nf(dMin)} to ${nf(dMax)}.`)}
                </div>
              )}
              {target == null && <div className={styles.note} style={{ marginTop: 8 }}>
                {mode === "count" ? t("Entre le count visé et le hank de la mèche.", "Enter the target count and the roving hank.") : t("Entre l'étirage total.", "Enter the total draft.")}
              </div>}
            </div>

            {target != null && (
              <div className={styles.card}>
                <div className={styles.head}>
                  <h2 className={styles.h2}>{t("Couples possibles", "Possible pairs")}</h2>
                  <p className={styles.sub}>{pairs.length} {t("à moins de", "within")} {tol} %{pairs.length > 14 ? t(" · 14 meilleurs affichés", " · best 14 shown") : ""}</p>
                </div>
                <div className={styles.row} style={{ marginBottom: 8 }}>
                  <Button size="sm" variant={useStock ? "primary" : "outline"} onClick={() => setD("cl.stock", useStock ? "0" : "1")}>
                    {useStock ? t("Stock magasin pris en compte", "Store stock taken into account") : t("Ignorer le stock", "Ignore stock")}
                  </Button>
                </div>
                {pairs.length === 0 ? (
                  <div className={`${styles.note} ${styles.toneCrit}`}>{t(`Aucun couple à moins de ${tol} % de cet étirage.`, `No pair within ${tol} % of this draft.`)}</div>
                ) : (
                  <>
                    {useStock && (
                      <div className={`${styles.note} ${mountable ? "" : styles.toneCrit}`} style={{ marginBottom: 8 }}>
                        {mountable
                          ? <><strong>{t(`${mountable} couple${plural(mountable)} montable${plural(mountable)}`, `${mountable} mountable pair${plural(mountable)}`)}</strong> {t(`sur ${pairs.length} (au moins ${g37.GEARS_PER_MACHINE} pignons de chaque en magasin), en tête de liste.`, `out of ${pairs.length} (at least ${g37.GEARS_PER_MACHINE} gears of each in store), listed first.`)}</>
                          : t("Aucun couple montable avec le stock actuel : il faut commander ou corriger l'inventaire dans l'onglet Gears.", "No pair can be mounted with current stock: order gears or correct the inventory in the Gears tab.")}
                      </div>
                    )}
                    <div className={styles.tableWrap}>
                      <table className={styles.table}>
                        <thead><tr><th>{t("Couple", "Pair")}</th><th>Draft</th>{hank ? <th>Count</th> : null}<th>{t("Écart", "Deviation")}</th>{useStock && <th>Stock</th>}</tr></thead>
                        <tbody>
                          {pairs.slice(0, 14).map((p) => (
                            <tr key={`${p.G}-${p.H}`}>
                              <td className={styles.num}><strong>G {p.G} / H {p.H}</strong></td>
                              <td className={styles.num}>{nf(p.dr)}</td>
                              {hank ? <td className={styles.num}>{nf(hank * p.dr)}</td> : null}
                              <td><Pill tone={Math.abs(p.err) <= 0.1 ? "ok" : Math.abs(p.err) <= 0.3 ? "" : "warn"}>{p.err >= 0 ? "+" : ""}{nf(p.err)} %</Pill></td>
                              {useStock && (
                                <td>
                                  {p.okG && p.okH ? <Pill tone="ok">{t("montable", "mountable")}</Pill>
                                    : <Pill tone="crit">{[!p.okG ? `G ${p.G} (${gearStock("G", p.G)})` : "", !p.okH ? `H ${p.H} (${gearStock("H", p.H)})` : ""].filter(Boolean).join(t(" et ", " and "))} {t("insuffisant", "insufficient")}</Pill>}
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
                <div className={styles.note} style={{ marginTop: 8 }}>
                  {t(`Plusieurs couples donnent le même étirage : seul le rapport H ÷ G compte. Il faut ${g37.GEARS_PER_MACHINE} pignons de chaque par machine.`, `Several pairs give the same draft: only the H ÷ G ratio matters. ${g37.GEARS_PER_MACHINE} gears of each are needed per machine.`)}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  /* ---------- Magasin ---------- */
  const renderMagasin = () => (
    <div className={styles.stack}>
      <div className={styles.head}><h1 className={styles.title}>{t("Magasin", "Store")}</h1><p className={styles.sub}>{t("Alerte automatique sous le seuil", "Automatic alert below threshold")}</p></div>
      {can("stockManage") && (
        <div className={styles.card}>
          <div className={styles.head}><h2 className={styles.h2}>{t("Ajouter un matériel", "Add an item")}</h2></div>
          <datalist id="stock-cats">
            {Array.from(new Set((state.stock ?? []).map((s) => s.category))).sort().map((c) => <option key={c} value={c} />)}
          </datalist>
          <div className={styles.row}>
            <label className={styles.field}><span className={styles.fieldLabel}>{t("Article", "Item")}</span>
              <Input value={d("sa.n")} onChange={(e) => setD("sa.n", e.target.value)} placeholder={t("Ex. Roulement 6204", "E.g. Bearing 6204")} /></label>
            <label className={styles.field}><span className={styles.fieldLabel}>{t("Catégorie", "Category")}</span>
              <Input list="stock-cats" value={d("sa.c")} onChange={(e) => setD("sa.c", e.target.value)} /></label>
            <label className={styles.field} style={{ maxWidth: 110 }}><span className={styles.fieldLabel}>{t("Unité", "Unit")}</span>
              <Input value={d("sa.u", "pcs")} onChange={(e) => setD("sa.u", e.target.value)} /></label>
            <label className={styles.field} style={{ maxWidth: 110 }}><span className={styles.fieldLabel}>{t("Quantité", "Quantity")}</span>
              <Input type="number" min="0" value={d("sa.q", "0")} onChange={(e) => setD("sa.q", e.target.value)} /></label>
            <label className={styles.field} style={{ maxWidth: 110 }}><span className={styles.fieldLabel}>{t("Seuil d'alerte", "Alert threshold")}</span>
              <Input type="number" min="0" value={d("sa.m", String(g37.STOCK_ALERT))} onChange={(e) => setD("sa.m", e.target.value)} /></label>
            <Button disabled={isSaving || !d("sa.n").trim() || !d("sa.c").trim()} onClick={() => {
              save({
                action: "stockAdd", name: d("sa.n").trim(), category: d("sa.c").trim(), unit: d("sa.u", "pcs").trim() || "pcs",
                quantity: Math.max(0, parseNum(d("sa.q", "0")) ?? 0),
                minimumQuantity: Math.max(0, parseNum(d("sa.m", String(g37.STOCK_ALERT))) ?? 0),
              });
              setD("sa.n", ""); setD("sa.q", "0");
            }}>{t("Ajouter", "Add")}</Button>
          </div></div>
      )}
      {lowStock.length > 0 && (
        <div className={styles.card}>
          <div className={styles.head}><h2 className={styles.h2}>{t("Alerte stock", "Stock alert")}</h2><p className={styles.sub}>{lowStock.length} {t("article(s)", "item(s)")}</p></div>
          <div className={styles.row}>{lowStock.map((s) => <Pill key={s.id} tone="crit">{s.name} · {s.quantity}</Pill>)}</div>
        </div>
      )}
      <div className={styles.card}>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>{t("Article", "Item")}</th><th>{t("Catégorie", "Category")}</th><th>{t("Quantité", "Quantity")}</th><th>{t("État", "Status")}</th>{can("stock") && <th>{t("Mettre à jour", "Update")}</th>}{can("stockManage") && <th>{t("Gérer", "Manage")}</th>}</tr></thead>
            <tbody>
              {(state.stock ?? []).map((s) => {
                const qty = Number(s.quantity);
                const min = Number(s.minimumQuantity || g37.STOCK_ALERT);
                const editing = d(`se.${s.id}`) === "1";
                return (
                  <React.Fragment key={s.id}>
                  <tr>
                    <td><strong>{s.name}</strong></td>
                    <td className={styles.meta}>{s.category}</td>
                    <td className={styles.num}>{qty} <span className={styles.meta}>{s.unit}</span></td>
                    <td>{qty < min ? <Pill tone="crit">{t("sous le seuil", "below threshold")}</Pill> : <Pill tone="ok">ok</Pill>}</td>
                    {can("stock") && (
                      <td>
                        <div className={styles.row} style={{ gap: 4 }}>
                          <Input className={styles.qtyInput} type="number" min="0" value={d(`st.${s.id}`, String(qty))} onChange={(e) => setD(`st.${s.id}`, e.target.value)} />
                          <Button size="sm" variant="outline" disabled={isSaving}
                            onClick={() => save({ action: "stockQty", id: s.id, quantity: Math.max(0, Number(d(`st.${s.id}`, String(qty))) || 0) })}>OK</Button>
                        </div>
                      </td>
                    )}
                    {can("stockManage") && (
                      <td>
                        <div className={styles.row} style={{ gap: 4 }}>
                          <Button size="sm" variant="outline" onClick={() => {
                            setD(`se.${s.id}`, editing ? "" : "1");
                            setD(`sen.${s.id}`, s.name); setD(`sec.${s.id}`, s.category);
                            setD(`seu.${s.id}`, s.unit); setD(`sem.${s.id}`, String(min));
                          }}>{editing ? t("Fermer", "Close") : t("Modifier", "Edit")}</Button>
                          {d(`sd.${s.id}`) === "1" ? (
                            <>
                              <Button size="sm" disabled={isSaving}
                                onClick={() => { save({ action: "stockDelete", id: s.id }); setD(`sd.${s.id}`, ""); }}>{t("Confirmer", "Confirm")}</Button>
                              <Button size="sm" variant="outline" onClick={() => setD(`sd.${s.id}`, "")}>{t("Annuler", "Cancel")}</Button>
                            </>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => setD(`sd.${s.id}`, "1")}>{t("Supprimer", "Delete")}</Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                  {editing && can("stockManage") && (
                    <tr>
                      <td colSpan={6}>
                        <div className={styles.row}>
                          <label className={styles.field}><span className={styles.fieldLabel}>{t("Article", "Item")}</span>
                            <Input value={d(`sen.${s.id}`, s.name)} onChange={(e) => setD(`sen.${s.id}`, e.target.value)} /></label>
                          <label className={styles.field}><span className={styles.fieldLabel}>{t("Catégorie", "Category")}</span>
                            <Input list="stock-cats" value={d(`sec.${s.id}`, s.category)} onChange={(e) => setD(`sec.${s.id}`, e.target.value)} /></label>
                          <label className={styles.field} style={{ maxWidth: 110 }}><span className={styles.fieldLabel}>{t("Unité", "Unit")}</span>
                            <Input value={d(`seu.${s.id}`, s.unit)} onChange={(e) => setD(`seu.${s.id}`, e.target.value)} /></label>
                          <label className={styles.field} style={{ maxWidth: 110 }}><span className={styles.fieldLabel}>{t("Seuil", "Threshold")}</span>
                            <Input type="number" min="0" value={d(`sem.${s.id}`, String(min))} onChange={(e) => setD(`sem.${s.id}`, e.target.value)} /></label>
                          <Button disabled={isSaving || !d(`sen.${s.id}`, s.name).trim() || !d(`sec.${s.id}`, s.category).trim()} onClick={() => {
                            save({
                              action: "stockEdit", id: s.id,
                              name: d(`sen.${s.id}`, s.name).trim(), category: d(`sec.${s.id}`, s.category).trim(),
                              unit: d(`seu.${s.id}`, s.unit).trim() || "pcs",
                              minimumQuantity: Math.max(0, parseNum(d(`sem.${s.id}`, String(min))) ?? 0),
                            });
                            setD(`se.${s.id}`, "");
                          }}>{t("Enregistrer", "Save")}</Button>
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );

  /* ---------- Discussion ---------- */
  const renderDiscussion = () => (
    <div className={styles.stack} style={{ paddingTop: 4 }}>
      {can("forum") && (
        <div className={styles.card}>
          {chatReply && (
            <div className={styles.note} style={{ marginBottom: 8 }}>
              <strong>{t("Réponse à", "Reply to")} {chatReply.author}</strong>
              <div className={styles.meta}>{chatReply.message || t("Message avec fichier joint", "Message with attachment")}</div>
              <Button size="sm" variant="outline" onClick={() => setChatReply(null)} style={{ marginTop: 6 }}>{t("Annuler", "Cancel")}</Button>
            </div>
          )}
          <label className={styles.field}><span className={styles.fieldLabel}>Message</span>
            <Input value={d("ch")} onChange={(e) => setD("ch", e.target.value)} placeholder={t("Pose ta question, partage une info ou @tague un collègue.", "Ask a question, share info or @tag a colleague.")} /></label>
          <div style={{ marginTop: 8 }}>
            <div className={styles.fieldLabel}>{t("Vous pouvez taguer en @", "You can tag with @")}</div>
          </div>
          <input
            ref={fileInput} type="file" style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              if (f && f.size > MAX_UPLOAD_BYTES) {
                toast.error(t(`Fichier trop lourd (${(f.size / 1048576).toFixed(1)} Mo) : 15 Mo maximum.`, `File too large (${(f.size / 1048576).toFixed(1)} MB): 15 MB maximum.`));
                e.target.value = "";
                return;
              }
              setChatFile(f);
            }}
          />
          <div className={styles.row} style={{ marginTop: 8 }}>
            <Button variant="outline" disabled={chatBusy} onClick={() => fileInput.current?.click()}>{t("📎 Joindre un fichier", "📎 Attach a file")}</Button>
            {chatFile && (
              <span className={styles.meta}>
                {chatFile.name} · {(chatFile.size / 1048576).toFixed(1)} {t("Mo", "MB")}{" "}
                <Button size="sm" variant="outline" disabled={chatBusy} onClick={() => { setChatFile(null); if (fileInput.current) fileInput.current.value = ""; }}>{t("Retirer", "Remove")}</Button>
              </span>
            )}
            <Button disabled={isSaving || chatBusy || (!d("ch").trim() && !chatFile)} onClick={async () => {
              const text = d("ch").trim();
              if (!chatFile) {
                save({ action: "chat", message: text, replyToId: chatReply?.id ?? null, mentionUserIds: chatMentions });
                setD("ch", ""); setChatReply(null); setChatMentions([]);
                return;
              }
              setChatBusy(true);
              try {
                const type = chatFile.type || "application/octet-stream";
                if (!isOnline()) throw new Error(t("Pas de réseau : la pièce jointe ne peut pas partir. Envoie le texte seul ou réessaie plus tard.", "No network: the attachment cannot be sent. Send the text alone or try again later."));
                const up = await postG37Upload({ fileName: chatFile.name, contentType: type, sizeBytes: chatFile.size });
                const put = await fetch(up.presignedUrl, { method: "PUT", headers: up.headers, body: chatFile });
                if (!put.ok) throw new Error(t("Le transfert du fichier a échoué.", "The file upload failed."));
                save({ action: "chat", message: text, replyToId: chatReply?.id ?? null, mentionUserIds: chatMentions, file: { key: up.fileKey, name: chatFile.name, type, size: chatFile.size } });
                setD("ch", ""); setChatFile(null); setChatReply(null); setChatMentions([]);
                if (fileInput.current) fileInput.current.value = "";
              } catch (err) {
                toast.error(err instanceof Error ? err.message : t("Envoi impossible.", "Unable to send."));
              } finally {
                setChatBusy(false);
              }
            }}>{chatBusy ? t("Envoi…", "Sending…") : t("Publier", "Post")}</Button>
          </div>
        </div>
      )}
      {(state.chat ?? []).length ? (state.chat ?? []).map((c) => {
        const canDelete = c.author === me.displayName || can("chatModerate");
        const isImage = !!c.fileType && c.fileType.startsWith("image/");
        return (
          <div key={c.id} className={styles.card}>
            <div className={`${styles.row} ${styles.between}`}>
              <strong>{c.author}</strong>
              <span className={styles.row} style={{ gap: 6 }}>
                <span className={styles.meta}>{fmtDate(c.createdAt)}</span>
                <Button size="sm" variant="outline" onClick={() => setChatReply({ id: c.id, author: c.author, message: c.message })}>{t("Répondre", "Reply")}</Button>
                {canDelete && (d(`cd.${c.id}`) === "1" ? (
                  <>
                    <Button size="sm" disabled={isSaving} onClick={() => { save({ action: "chatDelete", id: c.id }); setD(`cd.${c.id}`, ""); }}>{t("Confirmer", "Confirm")}</Button>
                    <Button size="sm" variant="outline" onClick={() => setD(`cd.${c.id}`, "")}>{t("Annuler", "Cancel")}</Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setD(`cd.${c.id}`, "1")}>{t("Supprimer", "Delete")}</Button>
                ))}
              </span>
            </div>
            {c.replyToId && (
              <div className={styles.note} style={{ marginTop: 6, borderLeft: "3px solid var(--accent)" }}>
                <strong>↪ {c.replyToAuthor}</strong>
                <div className={styles.meta}>{c.replyToMessage || t("Message précédent", "Previous message")}</div>
              </div>
            )}
            {c.message && <p style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>{c.message}</p>}
            {c.mentionUserIds.length > 0 && (
              <div className={styles.meta} style={{ marginTop: 6 }}>
                {t("Mentionné", "Mentioned")} : {c.mentionUserIds.map((id) => state.users.find((u) => u.id === id)?.displayName).filter(Boolean).map((n) => `@${n}`).join(", ")}
              </div>
            )}
            {c.fileName && (
              <div style={{ marginTop: 6 }}>
                {isImage && c.fileUrl && (
                  <a href={c.fileUrl} target="_blank" rel="noreferrer">
                    <img src={c.fileUrl} alt={c.fileName} style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 8, display: "block", marginBottom: 6 }} />
                  </a>
                )}
                {c.fileUrl
                  ? <a href={c.fileUrl} target="_blank" rel="noreferrer" download={c.fileName}>📎 {c.fileName}</a>
                  : <span>📎 {c.fileName}</span>}
                {c.fileSize != null && <span className={styles.meta}> · {c.fileSize >= 1048576 ? `${(c.fileSize / 1048576).toFixed(1)} ${t("Mo", "MB")}` : `${Math.max(1, Math.round(c.fileSize / 1024))} ${t("Ko", "KB")}`}</span>}
              </div>
            )}
          </div>
        );
      }) : <div className={styles.empty}>{t("Aucun message.", "No messages.")}</div>}
    </div>
  );

  /* ---------- Accès ---------- */
  const renderAcces = () => (
    <div className={styles.stack}>
      <div className={styles.head}><h1 className={styles.title}>{t("Accès", "Access")}</h1><p className={styles.sub}>{state.users.length} {t("comptes", "accounts")}</p></div>
      {me.role === "admin" && (
        <div className={styles.card}>
          <div className={styles.head}><h2 className={styles.h2}>{t("Sauvegarde", "Backup")}</h2></div>
          <p className={styles.meta}>
            {t(
              "Télécharge tout l'historique de l'atelier dans un fichier Excel : machines, pannes, maintenance, graissage, travaux, magasin, pignons, quarts, efficacité, équipe et discussion. Les mots de passe ne sont jamais inclus. Conseil : fais-le une fois par semaine et garde le fichier sur ton ordinateur ou ton Drive.",
              "Download the whole workshop history as an Excel file: machines, faults, maintenance, greasing, work, store, gears, shifts, efficiency, team and discussion. Passwords are never included. Tip: do it once a week and keep the file on your computer or Drive.",
            )}
          </p>
          <div>
            <Button onClick={downloadBackup} disabled={exportBusy}>
              {exportBusy ? t("Préparation du fichier…", "Preparing file…") : t("Télécharger la sauvegarde Excel", "Download Excel backup")}
            </Button>
          </div>
        </div>
      )}
      <div className={styles.card}>
        <div className={styles.head}><h2 className={styles.h2}>{t("Qui peut modifier quoi", "Who can edit what")}</h2></div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>{t("Poste", "Position")}</th>
              {([["machine", t("Relevés", "Readings")], ["gears", "Gears"], ["maint", "Maintenance"], ["grease", t("Graissage", "Greasing")], ["works", t("Travaux", "Work")], ["faultReport", t("Signaler panne", "Report fault")], ["faults", t("Clôturer panne", "Close fault")], ["stock", t("Magasin", "Store")], ["stockManage", t("Gérer magasin", "Manage store")], ["forum", "Discussion"], ["shifts", t("Quarts", "Shifts")], ["roles", t("Grades", "Roles")]] as Array<[Perm, string]>).map(([, l]) => <th key={l}>{l}</th>)}
            </tr></thead>
            <tbody>
              {Object.entries(g37.ROLES).map(([key, r]) => (
                <tr key={key}>
                  <td><strong>{roleName(key, r.n)}</strong></td>
                  {(["machine", "gears", "maint", "grease", "works", "faultReport", "faults", "stock", "stockManage", "forum", "shifts", "roles"] as Perm[]).map((p) => (
                    <td key={p}>{r.p.includes(p) ? <Pill tone="ok">{t("oui", "yes")}</Pill> : <span className={styles.meta}>—</span>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className={styles.card}>
        <div className={styles.head}><h2 className={styles.h2}>{t("Équipe", "Team")}</h2></div>
        {state.users.map((u) => (
          <div key={u.id} className={styles.userRow}>
            <div className={styles.userMain}>
              <strong>{u.displayName}</strong>
              {u.id === me.id && <Pill tone="accent">{t("toi", "you")}</Pill>}
              {u.role === "admin" && <Pill tone="ok">admin</Pill>}
              {u.pending && <Pill tone="warn">{t("en attente", "pending")}</Pill>}
              <span className={styles.meta}>{u.email}</span>
              <span className={styles.userSeen}>· {fmtSeen(u.lastSeen)}</span>
            </div>
            {can("roles") ? (
              <div className={styles.row} style={{ gap: 6 }}>
                <Picker
                  value={u.jobRole}
                  onChange={(v) => save({ action: "grade", userId: u.id, jobRole: v, team: u.team, pending: false })}
                  options={Object.entries(g37.ROLES).map(([k2, r]) => [k2, roleName(k2, r.n)] as [string, string])}
                />
                <Picker
                  value={u.team ?? "__none"}
                  onChange={(v) => save({ action: "grade", userId: u.id, jobRole: u.jobRole, team: v === "__none" ? null : v, pending: u.pending })}
                  options={([["__none", t("Sans quart", "No shift")]] as Array<[string, string]>).concat(g37.TEAMS.map((tm) => [tm, `${t("Équipe", "Team")} ${tm}`] as [string, string]))}
                />
                {u.role !== "admin" && (
                  <>
                    <Button size="sm" variant="outline" disabled={isSaving}
                      onClick={() => save({ action: "passwordResetAdmin", userId: u.id })}>
                      {t("Réinitialiser l'accès", "Reset access")}
                    </Button>
                    {d(`del.${u.id}`) === "1" ? (
                      <>
                        <Button size="sm" disabled={isSaving}
                          onClick={() => { save({ action: "deleteUser", userId: u.id }); setD(`del.${u.id}`, ""); }}>
                          {t("Confirmer", "Confirm")}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setD(`del.${u.id}`, "")}>{t("Annuler", "Cancel")}</Button>
                      </>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => setD(`del.${u.id}`, "1")}>{t("Supprimer", "Delete")}</Button>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className={styles.row} style={{ gap: 6 }}>
                <Pill>{roleName(u.jobRole, g37.ROLES[u.jobRole]?.n ?? u.jobRole)}</Pill>
                {u.team && <Pill tone="accent">{t("Équipe", "Team")} {u.team}</Pill>}
              </div>
            )}
          </div>
        ))}
        {!can("roles") && <div className={styles.note} style={{ marginTop: 10 }}>{t("Seul l'admin change les grades.", "Only the admin changes roles.")}</div>}
      </div>
    </div>
  );

  /* ---------- Recherche ---------- */
  const renderSearch = () => {
    const needle = q.trim().toLowerCase();
    const hit = (s: unknown) => String(s ?? "").toLowerCase().includes(needle);
    const ms = machines.filter((m) => hit(`m/c ${m.no}`) || hit(`machine ${m.no}`));
    const st = (state.stock ?? []).filter((s) => hit(s.name) || hit(s.category));
    const fa = (state.failures ?? []).filter((f) => hit(f.issue) || hit(f.notes) || hit(`m/c ${f.machineNo}`));
    const wk = (state.works ?? []).filter((w) => hit(w.title) || hit(`m/c ${w.machineNo}`));
    const total = ms.length + st.length + fa.length + wk.length;
    return (
      <div className={styles.stack}>
        <div className={styles.head}><h1 className={styles.title}>« {q} »</h1><p className={styles.sub}>{total} {t("résultat", "result")}{plural(total)}</p></div>
        {total === 0 && <div className={styles.empty}>{t("Rien trouvé.", "Nothing found.")}</div>}
        {ms.length > 0 && (
          <div className={styles.card}>
            <div className={styles.head}><h2 className={styles.h2}>Machines</h2></div>
            <div className={styles.machines}>
              {ms.map((m) => (
                <button key={m.no} className={styles.mcard} onClick={() => { setQ(""); setTab("machines"); setOpenMachine(m.no); }}>
                  <span className={styles.mcardNo}>M/C {m.no}</span>
                  <span className={styles.mcardSub}>{t("groupe", "group")} {g37.groupOf(m.no).id}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {st.length > 0 && (
          <div className={styles.card}>
            <div className={styles.head}><h2 className={styles.h2}>{t("Magasin", "Store")}</h2></div>
            {st.slice(0, 20).map((s) => (
              <div key={s.id} className={`${styles.item} ${styles.row} ${styles.between}`}>
                <strong>{s.name}</strong>
                <Pill tone={Number(s.quantity) < Number(s.minimumQuantity || 20) ? "crit" : "ok"}>{s.quantity}</Pill>
              </div>
            ))}
          </div>
        )}
        {fa.length > 0 && (
          <div className={styles.card}>
            <div className={styles.head}><h2 className={styles.h2}>{t("Pannes", "Faults")}</h2></div>
            {fa.slice(0, 15).map((f) => (
              <div key={f.id} className={styles.item}>
                <strong>M/C {f.machineNo} — {f.issue}</strong>
                <div className={styles.meta}>{f.reportedBy} · {fmtDate(f.openedAt)}</div>
              </div>
            ))}
          </div>
        )}
        {wk.length > 0 && (
          <div className={styles.card}>
            <div className={styles.head}><h2 className={styles.h2}>{t("Travaux", "Work")}</h2></div>
            {wk.slice(0, 15).map((w) => (
              <div key={w.id} className={styles.item}>
                <strong>{w.title}</strong> <Pill tone="accent">M/C {w.machineNo}</Pill>
                <div className={styles.meta}>{w.authorName} · {fmtDate(w.createdAt)}{daysTo(dayISO(w.createdAt)) < 0 ? ` · ${t(`En attente depuis ${-daysTo(dayISO(w.createdAt))} j`, `Waiting ${-daysTo(dayISO(w.createdAt))} d`)}` : ""}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  /* ---------- Rendu ---------- */
  const allowedTabs = g37.visibleTabs(me);
  const visibleTabs = TABS.filter(([key]) => key === "ia" ? !me.pending : (allowedTabs === null || allowedTabs.includes(key)));
  const activeTab = tab === "parametres" || tab === "profil" ? tab : visibleTabs.some(([key]) => key === tab) ? tab : (visibleTabs[0]?.[0] ?? "accueil");

  // Menus regroupés : chaque onglet garde ses propres droits, seul l'affichage est regroupé.
  const GROUPS = [
    { key: "g-entretien", fr: "Maintenance", en: "Maintenance", members: ["maintenance", "graissage", "lubrification", "schedule"] },
    { key: "g-pannes", fr: "Pannes & travaux", en: "Faults & works", members: ["pannes", "travaux"] },
  ];
  type NavItem = { key: string; fr: string; en: string; members?: string[] };
  const navItems: NavItem[] = [];
  for (const [key, fr, en] of visibleTabs) {
    const g = GROUPS.find((x) => x.members.includes(key));
    if (!g) { navItems.push({ key, fr, en }); continue; }
    if (navItems.some((n) => n.key === g.key || n.members?.includes(key))) continue;
    const members = g.members.filter((m) => visibleTabs.some(([vk]) => vk === m));
    if (members.length < 2) navItems.push({ key, fr, en });
    else navItems.push({ key: g.key, fr: g.fr, en: g.en, members });
  }
  const activeGroup = navItems.find((n) => n.members?.includes(activeTab));

  const bodyInner = () => {
    if (q.trim()) return renderSearch();
    switch (activeTab) {
      case "machines": return openMachine ? renderMachine(openMachine) : renderMachineList();
      case "travaux": return renderTravaux();
      case "gears": return renderGears();
      case "calcul": return renderCalcul();
      case "maintenance": return renderMaintenance();
      case "graissage": return renderCycle("grease");
      case "lubrification": return renderCycle("lub");
      case "schedule": return renderCycle("sched");
      case "pannes": return renderPannes();
      case "quarts": return renderQuarts();
      case "discussion": return (
        <MessagesView state={state} lang={lang} save={save} renderGroup={renderDiscussion} segment={msgSegment} onSegment={setMsgSegment}
          roleName={(k, f) => roleName(k, f)} />
      );
      case "ia": return renderAssistant();
      case "parametres": return <SettingsView state={state} lang={lang} setLang={setLang} onBack={() => goto("accueil")} />;
      case "profil": return (
        <ProfileView state={state} lang={lang} save={save} onBack={() => goto("accueil")} onLogout={() => void logout()}
          roleLabel={me.role === "admin" ? "Admin" : roleName(me.jobRole, g37.ROLES[me.jobRole]?.n ?? me.jobRole)} />
      );
      case "magasin": return renderMagasin();
      case "acces": return renderAcces();
      default: return renderAccueil();
    }
  };

  const body = () => (
    <>
      {activeGroup && !q.trim() && (
        <div className={styles.row} style={{ gap: 6, flexWrap: "wrap", margin: "12px 0 0" }}>
          {(activeGroup.members ?? []).map((k) => {
            const tb = TABS.find(([tk]) => tk === k);
            return (
              <Button key={k} size="sm" variant={activeTab === k ? "primary" : "outline"} onClick={() => { setTab(k); window.scrollTo(0, 0); }}>
                {k === "maintenance" ? t("Générale", "General") : tb ? (lang === "fr" ? tb[1] : tb[2]) : k}{k === "pannes" && openCount > 0 ? ` (${openCount})` : ""}
              </Button>
            );
          })}
        </div>
      )}
      {bodyInner()}
    </>
  );

  const dmUnread = [...new Set(dmList.filter((m) => m.from !== me.id).map((m) => m.from))].reduce((n, peer) => n + unreadFrom(peer, me.id, dmList), 0);
  const ico = (d: string) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
  );
  const inNav = (k: string) => !q.trim() && activeTab === k;
  const has = (k: string) => visibleTabs.some(([vk]) => vk === k);
  const mainKeys = ["accueil", "machines", "pannes", "travaux", "discussion"];
  const bottomItems = [
    { key: "accueil", label: t("Accueil", "Home"), icon: ico("M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"), badge: 0, active: inNav("accueil"), go: () => goto("accueil") },
    ...(has("machines") ? [{ key: "machines", label: "Machines", icon: ico("M4 20V8l5 3V8l5 3V4h6v16zM8 16h2M13 16h2"), badge: 0, active: inNav("machines"), go: () => goto("machines") }] : []),
    ...(has("pannes") || has("travaux") ? [{ key: "pannes", label: t("Pannes", "Faults"), icon: ico("M12 3l10 18H2L12 3zM12 10v5M12 18h.01"), badge: openCount, active: inNav("pannes") || inNav("travaux"), go: () => goto(has("pannes") ? "pannes" : "travaux") }] : []),
    ...(has("discussion") ? [{ key: "discussion", label: "Messages", icon: ico("M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"), badge: dmUnread, active: inNav("discussion"), go: () => goto("discussion") }] : []),
    { key: "plus", label: t("Plus", "More"), icon: ico("M5 12h.01M12 12h.01M19 12h.01"), badge: 0, active: !q.trim() && !mainKeys.includes(activeTab), go: () => setMoreOpen(true) },
  ];
  const moreItems = navItems.filter((n) => !mainKeys.includes(n.key) && !(n.members ?? []).some((m) => mainKeys.includes(m)));
  const myAvatar = state.users.find((u) => u.id === me.id)?.avatarUrl ?? null;
  // Les travaux restent accessibles depuis l'onglet Pannes (groupe « Pannes & travaux »).

  const needsPost = me.jobRole === "helper" && me.role !== "admin";

  return (
    <div className={`${styles.app} ${className ?? ""}`}>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <div className={styles.brand} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className={styles.brandLogo}>R/F</span>
            <span className={styles.brandText}>
              <span className={styles.brandName}>Spinning R/F</span>
              <span className={styles.brandAuthor}>
                <span className={`${styles.dot} ${me.pending ? styles.dotWarn : ""}`} />{" "}
                {me.displayName}{me.pending ? t(" (en attente)", " (pending)") : ""}
              </span>
            </span>
          </div>
          <div className={styles.grow} />
          <button className={styles.meBtn} onClick={() => goto("profil")} aria-label={t("Mon profil", "My profile")}>
            {myAvatar ? <img src={myAvatar} alt="" /> : <span>{me.displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("")}</span>}
          </button>
        </div>
        <div className={styles.topbarInner} style={{ paddingTop: 0, gap: 8 }}>
          <div className={styles.search} style={{ flex: 1 }}>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Rechercher une machine, une pièce…", "Search a machine, a part…")} />
          </div>
        </div>
        {(nearCount > 0 || p2p.lastExchange) && (
          <div className={styles.syncChip}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 7l10 10-5 5V2l5 5L7 17" /></svg>
            <span><strong>{nearCount}</strong> {t("collègue(s) à proximité", "colleague(s) nearby")}</span>
            {p2p.lastExchange && <span className={styles.syncAgo}>{new Date(p2p.lastExchange).toLocaleTimeString(lang === "fr" ? "fr-FR" : "en-GB", { hour: "2-digit", minute: "2-digit" })}</span>}
          </div>
        )}
      </header>

      <div className={styles.shell}>
        <AppStatusBar lang={lang} />
        {!pushOn && pushSupported() && (
          <div className={styles.card} style={{ marginTop: 16 }}>
            <div className={`${styles.row} ${styles.between}`}>
              <div style={{ minWidth: 0 }}>
                <strong>{t("Notifications de l'atelier", "Workshop notifications")}</strong>
                <div className={styles.meta}>
                  {t("Reçois une alerte sur ce téléphone pour les pannes, les maintenances et graissages à faire, les messages, les machines à l'arrêt et les stocks sous le seuil, même app fermée.", "Get an alert on this phone for faults, maintenance and greasing due, messages, stopped machines and stock below threshold, even with the app closed.")}
                </div>
              </div>
              <Button
                variant="primary"
                disabled={pushBusy}
                onClick={async () => {
                  setPushBusy(true);
                  try {
                    await enablePush();
                    if (isPushOptedIn()) {
                      alertSound();
                      toast.success(t("Notifications activées sur ce téléphone. Elles arrivent même lorsque l'app est fermée.", "Notifications enabled on this phone. They arrive even when the app is closed."));
                    } else {
                      toast.error(t("Activation impossible. Autorise les notifications pour Atelier G37 dans les réglages du téléphone.", "Could not enable notifications. Allow notifications for Atelier G37 in the phone settings."));
                    }
                  } catch {
                    toast.error(t("Ton téléphone a refusé les notifications. Autorise-les dans Réglages > Applications > Atelier G37.", "Your phone refused notifications. Allow them in Settings > Apps > Atelier G37."));
                  } finally {
                    setPushBusy(false);
                  }
                }}
              >
                {pushBusy ? t("Patiente…", "Please wait…") : t("Activer", "Enable")}
              </Button>
            </div>
          </div>
        )}
        {needsPost && (
          <div className={styles.card} style={{ marginTop: 16 }}>
            <div className={styles.head}><h2 className={styles.h2}>{t("Choisis ton poste", "Choose your position")}</h2></div>
            <p className={styles.sub}>{t("Tant que ton poste n'est pas défini, tu es en lecture seule.", "Until your position is set, you are in read-only mode.")}</p>
            <div className={styles.row} style={{ marginTop: 8 }}>
              <Picker label={t("Poste", "Position")} value={d("pr.role", "helper")} onChange={(v) => setD("pr.role", v)}
                options={Object.entries(g37.ROLES).filter(([k2]) => k2 !== "admin").map(([k2, r]) => [k2, roleName(k2, r.n)])} />
              {g37.ROLES[d("pr.role", "helper")]?.code && (
                <label className={styles.field} style={{ maxWidth: 220 }}><span className={styles.fieldLabel}>{t("Code d'habilitation", "Authorisation code")}</span>
                  <Input value={d("pr.code")} onChange={(e) => setD("pr.code", e.target.value)} /></label>
              )}
              <Button disabled={isSaving} onClick={() => save({ action: "profile", jobRole: d("pr.role", "helper"), code: d("pr.code") || null })}>{t("Valider mon poste", "Confirm my position")}</Button>
            </div>
          </div>
        )}
        {permMissing > 0 && activeTab === "accueil" && (
          <div className={styles.card} style={{ marginTop: 16, borderColor: "#6b5418" }}>
            <div className={`${styles.row} ${styles.between}`}>
              <div style={{ minWidth: 0 }}>
                <strong>{t(`${permMissing} autorisation(s) importante(s) à activer`, `${permMissing} important permission(s) to enable`)}</strong>
                <div className={styles.meta}>{t("Pour que les notifications et les appels sonnent même app fermée, et que l'échange sans Internet marche.", "So notifications and calls ring even when closed, and offline exchange works.")}</div>
              </div>
              <Button variant="primary" onClick={() => goto("parametres")}>{t("Voir", "View")}</Button>
            </div>
          </div>
        )}
        {p2p.available && p2p.needsPermission && (
          <div className={styles.card} style={{ marginTop: 16 }}>
            <div className={`${styles.row} ${styles.between}`}>
              <div style={{ minWidth: 0 }}>
                <strong>{t("Activer le mode sans Internet", "Enable offline mode")}</strong>
                <div className={styles.meta}>
                  {t("L'app échange les données, les messages et les mises à jour avec les téléphones des collègues proches, par Bluetooth et Wi-Fi, même sans Internet. Autorise Bluetooth, appareils à proximité, position, micro et notifications.", "The app exchanges data, messages and updates with nearby colleagues' phones over Bluetooth and Wi-Fi, even without Internet. Allow Bluetooth, nearby devices, location, microphone and notifications.")}
                </div>
              </div>
              <Button variant="primary" onClick={async () => {
                const ok = await requestP2PPermissions();
                if (ok) { await startP2P({ id: me.id, pending: me.pending }); toast.success(t("Mode sans Internet activé.", "Offline mode enabled.")); }
                else toast.error(t("Autorisations refusées. Active-les dans Réglages > Applications > Atelier G37.", "Permissions refused. Enable them in Settings > Apps > Atelier G37."));
              }}>{t("Activer", "Enable")}</Button>
            </div>
          </div>
        )}
        {body()}
      </div>

      <nav className={styles.bottomNav} aria-label={t("Navigation principale", "Main navigation")}>
        {bottomItems.map((it) => (
          <button key={it.key} className={`${styles.navBtn} ${it.active ? styles.navActive : ""}`} aria-current={it.active ? "page" : undefined} onClick={it.go}>
            <span style={{ position: "relative", display: "inline-flex" }}>
              {it.icon}
              {it.badge > 0 && <span className={styles.navBadge}>{it.badge > 99 ? "99+" : it.badge}</span>}
            </span>
            <span>{it.label}</span>
          </button>
        ))}
      </nav>

      <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("Plus", "More")}</DialogTitle></DialogHeader>
          <div className={styles.moreSheet}>
            <button className={styles.moreItem} onClick={() => { setMoreOpen(false); goto("profil"); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
              <span>{t("Profil", "Profile")}</span>
            </button>
            <button className={styles.moreItem} onClick={() => { setMoreOpen(false); goto("parametres"); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
              <span>{t("Paramètres", "Settings")}</span>{permMissing > 0 && <span className={styles.navBadge}>{permMissing}</span>}
            </button>
            {moreItems.map((it) => (
              <button key={it.key} className={styles.moreItem} onClick={() => { setMoreOpen(false); goto(it.members ? it.members[0] : it.key); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9 12h6" /></svg>
                <span>{lang === "fr" ? it.fr : it.en}</span>
              </button>
            ))}
            <button className={`${styles.moreItem} ${styles.moreDanger}`} onClick={() => { setMoreOpen(false); if (window.confirm(t("Se déconnecter de ce téléphone ?", "Log out from this phone?"))) void logout(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
              <span>{t("Déconnexion", "Log out")}</span>
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

