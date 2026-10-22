import { Nearby, nativeSoundsAvailable } from "./nearby";

// Sonneries de l'app (fichiers dans le module natif) et choix de l'utilisateur (Paramètres).
export const CALL_SOUNDS = [
  { key: "call_marimba", fr: "Marimba", en: "Marimba" },
  { key: "call_classique", fr: "Téléphone classique", en: "Classic phone" },
  { key: "call_douce", fr: "Cloches douces", en: "Soft bells" },
  { key: "call_atelier", fr: "Atelier (énergique)", en: "Workshop (energetic)" },
] as const;
export const ALERT_SOUNDS = [
  { key: "alert_atelier", fr: "Alerte atelier", en: "Workshop alert" },
  { key: "alert_sirene", fr: "Sirène courte", en: "Short siren" },
  { key: "alert_carillon", fr: "Carillon", en: "Chime" },
  { key: "alert_bip", fr: "Double bip", en: "Double beep" },
  { key: "alert_message", fr: "Notes claires", en: "Bright notes" },
] as const;

export type SoundPrefs = { call: string; alert: string; message: string; loud: boolean };
const KEY = "g37.soundPrefs";
const DEFAULTS: SoundPrefs = { call: "call_marimba", alert: "alert_atelier", message: "alert_message", loud: true };

export function soundPrefs(): SoundPrefs {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<SoundPrefs>) }; } catch { return DEFAULTS; }
}

export async function setSoundPrefs(p: Partial<SoundPrefs>) {
  const next = { ...soundPrefs(), ...p };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* stockage indisponible */ }
  if (await nativeSoundsAvailable()) await Nearby.setSoundPrefs(next).catch(() => {});
  return next;
}

// Au démarrage : le téléphone reçoit les choix (canaux de notification avec la bonne sonnerie).
export async function applySoundPrefs() {
  if (await nativeSoundsAvailable()) await Nearby.setSoundPrefs(soundPrefs()).catch(() => {});
}

// Sons joués quand l'app est ouverte.
export async function playAlert(kind: "alert" | "message" = "alert") {
  const p = soundPrefs();
  if (await nativeSoundsAvailable()) {
    await Nearby.playSound({ name: kind === "message" ? p.message : p.alert, usage: p.loud ? "alarm" : "notification" }).catch(() => {});
    return;
  }
  beep();
}

export async function startRingtone() {
  if (await nativeSoundsAvailable()) {
    await Nearby.playSound({ name: soundPrefs().call, loop: true, usage: "ringtone" }).catch(() => {});
  } else {
    beepLoop();
  }
  if (navigator.vibrate) navigator.vibrate([800, 400, 800, 400, 800, 400, 800, 400, 800]);
}

export async function stopRingtone() {
  stopBeepLoop();
  if (navigator.vibrate) navigator.vibrate(0);
  if (await nativeSoundsAvailable()) await Nearby.stopSound().catch(() => {});
}

export async function previewSound(name: string, usage: "ringtone" | "alarm" | "notification") {
  if (await nativeSoundsAvailable()) await Nearby.playSound({ name, usage }).catch(() => {});
  else beep();
}

// Repli (navigateur ou ancien APK) : notes synthétisées.
let ctx: AudioContext | null = null;
let loopTimer: ReturnType<typeof setInterval> | null = null;
function beep() {
  try {
    ctx = ctx ?? new AudioContext();
    const t0 = ctx.currentTime;
    [988, 1319, 1568].forEach((f, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.frequency.value = f;
      osc.connect(gain);
      gain.connect(ctx!.destination);
      const t = t0 + i * 0.16;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.45, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      osc.start(t);
      osc.stop(t + 0.16);
    });
  } catch { /* son refusé */ }
}
function beepLoop() {
  stopBeepLoop();
  beep();
  loopTimer = setInterval(beep, 1500);
}
function stopBeepLoop() {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
}
