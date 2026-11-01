// Question du Robot G37 (01/11/2026) : vers 16h30, le robot « appelle » (écran d'appel qui sonne) le superviseur,
// puis les responsables de maintenance, puis l'admin, pour demander :
//   1) la maintenance des machines prévues aujourd'hui est-elle finie ?
//   2) quelle(s) machine(s) passe(nt) en maintenance demain ?
// En répondant à l'appel, cette fenêtre lit la question à voix haute et propose les réponses.
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./RobotAsk.module.css";

type Ask = { id: number; question: string; machines: number[]; already: number[]; status: string;
  askDone: boolean; askTomorrow: boolean; tomorrowDay: string; planned: number[] };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/_api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "Erreur");
  return data as T;
}

/** Ouvre la question du robot (depuis l'écran d'appel ou une notification). */
export function openRobotAsk(id: number | null, speak = true) {
  window.dispatchEvent(new CustomEvent("g37:robot-ask", { detail: { id, speak } }));
}

const ALL = Array.from({ length: 28 }, (_, i) => i + 1);
const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

export function RobotAsk() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [done, setDone] = useState<number[]>([]);
  const [tomorrow, setTomorrow] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const snoozed = useRef<Record<number, number>>({});
  const lastCheck = useRef(0);

  const stopVoice = () => { try { audio.current?.pause(); } catch { /* rien */ } };

  const play = useCallback(async (id: number) => {
    stopVoice();
    try {
      const res = await fetch(`/_api/g37/ask_audio?id=${id}`);
      if (!res.ok) return;
      const url = URL.createObjectURL(await res.blob());
      const a = new Audio(url);
      audio.current = a;
      a.onended = () => URL.revokeObjectURL(url);
      await a.play().catch(() => {});
    } catch { /* pas de voix : le texte suffit */ }
  }, []);

  const load = useCallback(async (id: number | null, speak: boolean, force: boolean) => {
    try {
      const r = await api<{ ask: Ask | null }>(`g37/ask${id ? `?id=${id}` : ""}`);
      const a = r.ask;
      if (!a || a.status !== "pending" || (!a.askDone && !a.askTomorrow)) return;
      if (!force && (snoozed.current[a.id] ?? 0) > Date.now()) return;
      setAsk(a);
      setDone(a.machines.filter((n) => !a.already.includes(n)));
      setTomorrow(a.planned ?? []);
      setLines(null);
      setError(null);
      if (speak) void play(a.id);
    } catch { /* hors ligne ou pas connecté : on réessaiera */ }
  }, [play]);

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ id: number | null; speak?: boolean }>).detail ?? { id: null };
      void load(d.id ?? null, d.speak !== false, true);
    };
    window.addEventListener("g37:robot-ask", on);
    return () => window.removeEventListener("g37:robot-ask", on);
  }, [load]);

  // Au démarrage et au retour sur l'app : une question attend-elle une réponse ? (au plus toutes les 5 minutes)
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastCheck.current < 5 * 60_000) return;
      lastCheck.current = Date.now();
      void load(null, false, false);
    };
    check();
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, [load]);

  useEffect(() => () => stopVoice(), []);

  if (!ask) return null;
  const left = ask.machines.filter((n) => !ask.already.includes(n));
  const toggle = (set: (f: (p: number[]) => number[]) => void, n: number) =>
    set((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n].sort((a, b) => a - b)));

  const send = async () => {
    setBusy(true);
    setError(null);
    stopVoice();
    try {
      const r = await api<{ lines?: string[] }>("g37/ask_answer", {
        id: ask.id, done: ask.askDone ? done : null, tomorrow: ask.askTomorrow ? tomorrow : null,
      });
      setLines(r.lines?.length ? r.lines : ["Réponse enregistrée."]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Réponse non envoyée");
    } finally {
      setBusy(false);
    }
  };
  const later = () => {
    stopVoice();
    snoozed.current[ask.id] = Date.now() + 60 * 60_000;
    setAsk(null);
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Question du Robot G37">
      <div className={styles.card}>
        <div className={styles.head}>
          <span className={styles.bot} aria-hidden="true">🤖</span>
          <div>
            <div className={styles.title}>Robot G37</div>
            <div className={styles.sub}>Maintenance — question du soir</div>
          </div>
          <button type="button" className={styles.voice} onClick={() => void play(ask.id)} aria-label="Réécouter la question">🔊</button>
        </div>

        {lines ? (
          <>
            <ul className={styles.result}>{lines.map((l) => <li key={l}>{l}</li>)}</ul>
            <button type="button" className={styles.primary} onClick={() => setAsk(null)}>Fermer</button>
          </>
        ) : (
          <>
            {ask.askDone && left.length > 0 && (
              <section className={styles.block}>
                <p className={styles.question}>1. Maintenance d'aujourd'hui : <b>coche les machines finies</b></p>
                <div className={styles.machines}>
                  {left.map((n) => (
                    <button key={n} type="button" className={`${styles.chip} ${done.includes(n) ? styles.chipOn : ""}`} onClick={() => toggle(setDone, n)} aria-pressed={done.includes(n)}>
                      {done.includes(n) ? "✓ " : ""}Mc {n}
                    </button>
                  ))}
                </div>
                {ask.already.length > 0 && <p className={styles.note}>Déjà enregistrée(s) : {ask.already.map((n) => `Mc ${n}`).join(", ")}</p>}
              </section>
            )}
            {ask.askTomorrow && (
              <section className={styles.block}>
                <p className={styles.question}>{ask.askDone ? "2. " : ""}Demain ({ddmm(ask.tomorrowDay)}) en maintenance :{ask.planned.length > 0 && <> déjà prévu <b>{ask.planned.map((n) => `Mc ${n}`).join(", ")}</b>, confirme ou change</>}</p>
                <div className={styles.grid}>
                  {ALL.map((n) => (
                    <button key={n} type="button" className={`${styles.cell} ${tomorrow.includes(n) ? styles.chipOn : ""}`} onClick={() => toggle(setTomorrow, n)} aria-pressed={tomorrow.includes(n)}>{n}</button>
                  ))}
                </div>
                <p className={styles.note}>{tomorrow.length ? `Demain : ${tomorrow.map((n) => `Mc ${n}`).join(", ")}` : "Aucune machine demain"}</p>
              </section>
            )}
            {error && <p className={styles.error}>{error}</p>}
            <button type="button" className={styles.yes} disabled={busy} onClick={() => void send()}>{busy ? "Envoi…" : "Envoyer la réponse"}</button>
            <button type="button" className={styles.later} disabled={busy} onClick={later}>Plus tard</button>
            <p className={styles.note}>Machine cochée = maintenance enregistrée aujourd'hui, prochaine dans 30 jours.</p>
          </>
        )}
      </div>
    </div>
  );
}
