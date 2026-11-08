// Atelier G37 — numéro robot WhatsApp — version 3 (03/11/2026), reconstruite pour tenir la connexion.
// • Lit les groupes « Spinning Shift Supervisors » (lecture seule) et « Ring Fram Local Team ».
// • Envoie chaque message à G37 (fonction wa-bot), qui le range dans Pannes / Travaux / Maintenance.
// • Du lundi au samedi à 8h, poste le rapport dans « Ring Fram Local Team ».
// • En privé : assistant technique (questions, photos, notes vocales) ; question du soir (16h30).
//
// Ce qui change par rapport à la v2.1 (cause des déconnexions à répétition) :
// 1. Bibliothèque WhatsApp figée sur une version testée (plus de « latest » qui change sans prévenir).
// 2. Une seule copie du robot : verrou qui marche sur Windows (le PID seul ne suffit pas).
// 3. Déconnexion 401 au DÉMARRAGE (session morte sur le disque) : on nettoie, on attend que la ligne
//    soit vraiment coupée, puis on demande UN code — plus de code demandé pendant que l'ancien
//    appareil est encore en train d'être retiré (c'est ce qui donnait « Impossible de connecter l'appareil »).
// 4. Code 515 « restart required » (normal juste après l'association) : relance immédiate, sans toucher à la session.
// 5. Reconnexion : attente croissante, jamais deux reconnexions en même temps, et chien de garde si
//    WhatsApp ne dit plus rien pendant 4 minutes.
// 6. Groupes relus toutes les heures (les noms changent), rien n'est jeté si un groupe manque.
// 7. Journal plus clair : chaque déconnexion donne le code ET la raison en français.
"use strict";
const fs = require("fs");
const path = require("path");
const pino = require("pino");

const DIR = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
const AUTH_DIR = path.join(DIR, "auth");
const STATE_FILE = path.join(DIR, "state.json");
const PENDING_FILE = path.join(DIR, "pending.json");
const LOG_FILE = path.join(DIR, "bot.log");
const LOCK_FILE = path.join(DIR, "bot.lock");
const CODE_FILE = path.join(DIR, "CODE.txt");
const QR_FILE = path.join(DIR, "qr.png");

// ---------- Journal ----------
function localNow() { return new Date(Date.now() + (cfg.utcOffsetHours ?? 1) * 3600_000); }
const todayStr = () => localNow().toISOString().slice(0, 10);
function log(...args) {
  const line = `[${localNow().toISOString().replace("T", " ").slice(0, 19)}] ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
    if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) { try { fs.unlinkSync(LOG_FILE + ".old"); } catch {} fs.renameSync(LOG_FILE, LOG_FILE + ".old"); }
  } catch {}
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, data) { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { log("Écriture impossible :", file, e); } }

// ---------- Une seule copie à la fois (verrou avec « battement », fiable sur Windows) ----------
// Le fichier bot.lock contient le PID et l'heure du dernier battement (toutes les 20 s).
// Un verrou dont le battement a plus de 90 s est considéré mort (robot tué sans ménagement).
function takeLock() {
  try {
    const other = readJson(LOCK_FILE, null);
    if (other && other.pid !== process.pid && Date.now() - Number(other.at || 0) < 90_000) {
      let alive = true;
      try { process.kill(other.pid, 0); } catch { alive = false; }
      if (alive) {
        log(`⛔ Le robot tourne déjà (processus ${other.pid}, battement il y a ${Math.round((Date.now() - other.at) / 1000)} s). Cette copie s'arrête.`);
        log("   Pour le relancer proprement : 3-arreter.bat puis 1-demarrer.bat.");
        process.exit(3);
      }
    }
  } catch {}
  const beat = () => writeJson(LOCK_FILE, { pid: process.pid, at: Date.now() });
  beat();
  setInterval(beat, 20_000).unref();
  const cleanup = () => { try { if (readJson(LOCK_FILE, {}).pid === process.pid) fs.unlinkSync(LOCK_FILE); } catch {} };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) process.on(sig, () => process.exit(0));
}

// ---------- Alerte Telegram (facultative) ----------
async function telegram(text) {
  if (!cfg.telegramBotToken || !cfg.telegramChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.telegramChatId, text: `G37 WhatsApp : ${text}` }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) { log("Telegram :", e); }
}

// ---------- Appels à G37 ----------
async function api(method, route, body, timeoutMs = 30_000) {
  const res = await fetch(`${cfg.apiUrl}/${route}`, {
    method,
    headers: { "x-wa-key": cfg.apiKey, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Messages pas encore transmis (coupure Internet) : gardés sur disque et renvoyés chaque minute.
let pending = readJson(PENDING_FILE, []);
async function deliver(item) {
  try {
    const r = await api("POST", "ingest", item, 60_000);
    if (r.done && r.done.length) log(`↳ ${item.group} | ${r.done.join(" ; ")}`);
    if (r.reply) await say(r.reply);
    return true;
  } catch (e) {
    log(`Envoi à G37 impossible (${e.message}) — nouvel essai plus tard.`);
    return false;
  }
}
let flushing = false;
async function flushPending() {
  if (flushing || !pending.length) return;
  flushing = true;
  try {
    const keep = [];
    for (const item of pending) if (!(await deliver(item))) keep.push(item);
    pending = keep.slice(-500);
    writeJson(PENDING_FILE, pending);
  } finally { flushing = false; }
}
setInterval(() => flushPending().catch((e) => log("Rattrapage :", e)), 60_000);

// Numéro de téléphone de l'expéditeur (WhatsApp cache parfois le numéro derrière un identifiant « @lid »).
function phoneOf(m) {
  const k = m.key || {};
  for (const j of [k.senderPn, k.participantPn, k.remoteJidAlt, k.participantAlt, k.participant, k.remoteJid]) {
    if (j && /@s\.whatsapp\.net$/.test(String(j))) return String(j).split("@")[0].split(":")[0];
  }
  return null;
}

// ---------- Bibliothèque WhatsApp (Baileys) ----------
let B = null;
async function loadBaileys() {
  const mod = await import("@whiskeysockets/baileys");
  const pick = (k) => mod[k] ?? mod.default?.[k];
  B = {
    makeWASocket: pick("makeWASocket") ?? (typeof mod.default === "function" ? mod.default : mod.default?.default),
    useMultiFileAuthState: pick("useMultiFileAuthState"),
    DisconnectReason: pick("DisconnectReason") ?? {},
    fetchLatestBaileysVersion: pick("fetchLatestBaileysVersion"),
    Browsers: pick("Browsers"),
    downloadMediaMessage: pick("downloadMediaMessage"),
    makeCacheableSignalKeyStore: pick("makeCacheableSignalKeyStore"),
  };
  if (typeof B.makeWASocket !== "function") throw new Error("bibliothèque Baileys introuvable — lance « npm.cmd install »");
  try { log(`Baileys ${require("@whiskeysockets/baileys/package.json").version} chargé.`); } catch {}
}

// Codes de déconnexion en français (pour le journal).
function reasonText(code) {
  const R = B.DisconnectReason;
  switch (code) {
    case R.loggedOut ?? 401: return "appareil retiré de WhatsApp (401)";
    case R.connectionReplaced ?? 440: return "une autre copie du robot s'est connectée (440)";
    case R.restartRequired ?? 515: return "WhatsApp demande un redémarrage (515, normal après l'association)";
    case R.badSession ?? 500: return "session abîmée sur le disque (500)";
    case R.connectionClosed ?? 428: return "connexion fermée (428)";
    case R.connectionLost ?? 408: return "connexion perdue ou délai dépassé (408)";
    case R.multideviceMismatch ?? 411: return "multi-appareils non activé (411)";
    case R.forbidden ?? 403: return "numéro bloqué par WhatsApp (403)";
    case R.unavailableService ?? 503: return "WhatsApp indisponible (503)";
    default: return `raison inconnue (${code ?? "?"})`;
  }
}

// Session sur le disque : existe-t-elle, et a-t-elle déjà été associée ?
function sessionState() {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, "creds.json"), "utf8"));
    return { exists: true, registered: !!creds.registered, me: creds.me?.id || null };
  } catch { return { exists: false, registered: false, me: null }; }
}
function archiveSession(why) {
  try {
    if (!fs.existsSync(AUTH_DIR)) return;
    const dest = path.join(DIR, `auth-ancien-${localNow().toISOString().replace(/[:T]/g, "-").slice(0, 19)}`);
    fs.renameSync(AUTH_DIR, dest);
    log(`Session mise de côté (${why}) → ${path.basename(dest)}`);
    // On ne garde que les 3 dernières sessions archivées.
    const old = fs.readdirSync(DIR).filter((f) => f.startsWith("auth-ancien-")).sort();
    for (const f of old.slice(0, -3)) { try { fs.rmSync(path.join(DIR, f), { recursive: true, force: true }); } catch {} }
  } catch (e) { log("Archivage de la session impossible :", e); }
}

// ---------- Envois WhatsApp ----------
let sock = null;
let connected = false;
let groupIds = new Map(); // jid -> nom du groupe
let reportJid = null;
let memberIds = new Set();
const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const userPart = (j) => String(j || "").split("@")[0].split(":")[0];
function isMember(...ids) { return ids.some((j) => j && memberIds.has(userPart(j))); }

// Verrou : le robot n'écrit JAMAIS dans un groupe en lecture seule (ex. « Spinning Shift Supervisors »).
// Seul groupe autorisé : le groupe de rapport (Ring Fram Local Team). Les messages privés restent permis.
const readOnlyNames = () => (Array.isArray(cfg.readOnlyGroups) ? cfg.readOnlyGroups : String(cfg.readOnlyGroups || "").split(/[,;\n]/)).map(norm).filter(Boolean);
function mayWrite(jid) {
  if (!String(jid).endsWith("@g.us")) return true;
  if (!reportJid || jid !== reportJid) return false;
  const name = groupIds.get(jid);
  return !(name && readOnlyNames().includes(norm(name)));
}
async function send(jid, content, opts) {
  if (!sock || !connected || !jid) return false;
  if (!mayWrite(jid)) { log(`⛔ Envoi bloqué vers ${groupIds.get(jid) || jid} (groupe en lecture seule).`); return false; }
  try { await sock.sendMessage(jid, content, opts); return true; }
  catch (e) { log("Envoi WhatsApp impossible :", e); return false; }
}
const say = (text) => (text ? send(reportJid, { text }) : Promise.resolve(false));

// Note vocale : WAV (envoyé par G37) → OGG Opus (format WhatsApp), via ffmpeg-static.
let ffmpegWarned = false;
function toVoiceNote(wavB64) {
  let ffmpeg;
  try { ffmpeg = require("ffmpeg-static"); } catch {
    if (!ffmpegWarned) { ffmpegWarned = true; log("Notes vocales désactivées (module absent : npm.cmd install ffmpeg-static)."); }
    return Promise.resolve(null);
  }
  const { spawn } = require("child_process");
  return new Promise((ok) => {
    const p = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "24k", "-ac", "1", "-ar", "16000", "-f", "ogg", "pipe:1"]);
    const out = [];
    p.stdout.on("data", (d) => out.push(d));
    p.on("error", () => ok(null));
    p.on("close", (code) => ok(code === 0 && out.length ? Buffer.concat(out) : null));
    p.stdin.on("error", () => {});
    p.stdin.end(Buffer.from(wavB64, "base64"));
  });
}

async function deliverOutbox(m) {
  const jid = m.to_phone ? `${String(m.to_phone).replace(/\D/g, "")}@s.whatsapp.net` : reportJid;
  if (!sock || !connected || !jid) return false;
  if (!mayWrite(jid)) { log(`⛔ Message de la file bloqué vers ${groupIds.get(jid) || jid} (lecture seule).`); return true; }
  try {
    if (m.voice) {
      const ogg = await toVoiceNote(m.voice);
      if (ogg) await sock.sendMessage(jid, { audio: ogg, mimetype: "audio/ogg; codecs=opus", ptt: true }).catch((e) => log("Note vocale non envoyée :", e));
    }
    if (m.text) await sock.sendMessage(jid, { text: m.text });
    if (m.to_phone) log(`Message privé envoyé à ${m.to_phone}${m.voice ? " (avec note vocale)" : ""}`);
    return true;
  } catch (e) { log("Envoi WhatsApp impossible :", e); return false; }
}

// Boîte d'envoi G37 (confirmations, rappels, question du soir) : toutes les 30 s, seulement si connecté.
// Cet appel sert aussi de « je suis vivant » côté serveur.
let outboxBusy = false;
setInterval(async () => {
  if (outboxBusy || !sock || !connected || !reportJid) return;
  outboxBusy = true;
  try {
    const { messages } = await api("GET", "outbox");
    const sent = [];
    for (const m of messages || []) if (await deliverOutbox(m)) sent.push(m.id);
    if (sent.length) { await api("POST", "outbox-ack", { ids: sent }); log(`Messages G37 envoyés : ${sent.length}`); }
  } catch (e) { log("Boîte d'envoi G37 :", e); }
  finally { outboxBusy = false; }
}, 30_000);

// Rappels, pannes répétitives, question du soir : toutes les 10 minutes (même déconnecté : l'app sonne quand même).
setInterval(() => api("GET", "tick", null, 60_000).catch((e) => log("Contrôle périodique :", e)), 10 * 60_000);

// ---------- Lecture d'un message WhatsApp ----------
function unwrap(msg) {
  let m = msg;
  for (let i = 0; i < 4 && m; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message
      || m.documentWithCaptionMessage?.message || m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}
function textOf(msg) {
  const m = unwrap(msg);
  if (!m) return "";
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || "";
}
function contextOf(msg) {
  const m = unwrap(msg);
  if (!m) return null;
  return m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo || m.documentMessage?.contextInfo || m.audioMessage?.contextInfo || null;
}
const sizeOf = (media) => Number(media?.fileLength?.toString?.() ?? media?.fileLength ?? 0);

// ---------- Rapport du matin ----------
// Rapport du matin (04/11/2026) : demandé à la fonction wa-report, qui annonce les métiers programmés dans l'app
// et n'envoie la liste des machines en retard que si aucun métier n'est programmé.
// Si wa-report ne répond pas, on reprend l'ancien rapport de wa-bot.
async function reportText() {
  const url = String(cfg.apiUrl || "").replace(/\/wa-bot\/?$/, "/wa-report");
  if (url && url !== cfg.apiUrl) {
    try {
      const res = await fetch(`${url}/report`, { headers: { "x-wa-key": cfg.apiKey }, signal: AbortSignal.timeout(30_000) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.text) return data.text;
      log(`Rapport wa-report indisponible (${data.error || `HTTP ${res.status}`}) — ancien rapport utilisé.`);
    } catch (e) { log("Rapport wa-report indisponible — ancien rapport utilisé :", e); }
  }
  const text = await reportText();
  return text;
}
let reportBusy = false;
async function sendReport(reason) {
  if (!sock || !connected || !reportJid || reportBusy) return false;
  reportBusy = true;
  try {
    const { text } = await api("GET", "report");
    if (!mayWrite(reportJid)) return false;
    await sock.sendMessage(reportJid, { text });
    log(`Rapport envoyé (${reason}).`);
    return true;
  } catch (e) {
    log("Rapport non envoyé :", e);
    await telegram(`rapport du matin non envoyé (${e.message})`);
    return false;
  } finally { reportBusy = false; }
}
setInterval(async () => {
  const now = localNow();
  const state = readJson(STATE_FILE, {});
  const day = todayStr();
  const hour = now.getUTCHours();
  if (!(cfg.reportDays ?? [1, 2, 3, 4, 5, 6]).includes(now.getUTCDay())) return;
  if (hour < (cfg.reportHour ?? 8) || hour >= 12 || state.lastReport === day) return;
  if (await sendReport("programmé")) writeJson(STATE_FILE, { ...state, lastReport: day });
}, 30_000);

// ---------- Médias ----------
let sharpWarned = false;
async function shrink(buffer, mime) {
  try {
    const sharp = require("sharp");
    const data = await sharp(Buffer.from(buffer)).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
    return { data, mime: "image/jpeg" };
  } catch (e) {
    if (!sharpWarned) { sharpWarned = true; log("Photo envoyée sans réduction (module sharp absent : npm.cmd install sharp)."); }
    return { data: Buffer.from(buffer), mime: mime || "image/jpeg" };
  }
}
async function download(m) {
  return B.downloadMediaMessage(m, "buffer", {}, { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage });
}

async function handlePhoto(m, jid, group, sender, caption, ts) {
  const img = unwrap(m.message).imageMessage;
  if (sizeOf(img) > 8 * 1024 * 1024) { log(`${group} | ${sender} : photo trop lourde, ignorée`); return; }
  log(`${group} | ${sender} : 📷 photo${caption ? ` (« ${caption.slice(0, 60)} »)` : ""} — lecture…`);
  let buffer;
  try { buffer = await download(m); } catch (e) { log("Photo non téléchargée :", e); return; }
  const { data, mime } = await shrink(buffer, img.mimetype);
  const body = { msgId: `${jid}:${m.key.id}`, group, sender, phone: phoneOf(m), at: ts, caption, mime, image: data.toString("base64") };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await api("POST", "slip", body, 120_000);
      if (r.done && r.done.length) log(`↳ ${group} | ${r.done.join(" ; ")}`);
      else if (r.action) log(`↳ ${group} | photo : ${r.action}`);
      if (r.reply) await say(r.reply);
      return;
    } catch (e) {
      log(`Lecture de la photo impossible (essai ${attempt}/3) : ${e.message}`);
      await sleep(20_000);
    }
  }
}

async function handlePdf(m, jid, group, sender, caption, ts) {
  const doc = unwrap(m.message).documentMessage;
  const fileName = doc.fileName || doc.title || "rapport.pdf";
  if (sizeOf(doc) > 15 * 1024 * 1024) { log(`${group} | ${sender} : PDF trop lourd, ignoré`); return; }
  log(`${group} | ${sender} : 📄 ${fileName} — lecture…`);
  let buffer;
  try { buffer = await download(m); } catch (e) { log("PDF non téléchargé :", e); return; }
  const body = { msgId: `${jid}:${m.key.id}`, group, sender, phone: phoneOf(m), at: ts, caption, fileName, pdf: Buffer.from(buffer).toString("base64") };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await api("POST", "report-pdf", body, 150_000);
      if (r.duplicate) return;
      if (r.ok) { log(`↳ ${group} | rapport ${r.ignored ? `ignoré (${r.ignored})` : `lu : ${r.rows} métiers, ${r.faults} panne(s)`}`); return; }
      log(`Rapport non lu (essai ${attempt}/3) : ${r.error}`);
      if (r.quota) return;
    } catch (e) { log(`Rapport non lu (essai ${attempt}/3) : ${e.message}`); }
    await sleep(30_000);
  }
}

async function handleVoice(m, jid, group, sender, ts) {
  const audio = unwrap(m.message).audioMessage;
  if (sizeOf(audio) > 10 * 1024 * 1024) { log(`${group} | ${sender} : vocal trop long, ignoré`); return; }
  let buffer;
  try { buffer = await download(m); } catch (e) { log("Vocal non téléchargé :", e); return; }
  const ctx = contextOf(m.message);
  const quoted = ctx?.quotedMessage ? textOf(ctx.quotedMessage) : null;
  const body = { msgId: `${jid}:${m.key.id}`, group, sender, phone: phoneOf(m), at: ts, quoted, mime: (audio.mimetype || "audio/ogg").split(";")[0], audio: Buffer.from(buffer).toString("base64") };
  try {
    const r = await api("POST", "voice", body, 120_000);
    log(`${group} | ${sender} : 🎤 « ${String(r.heard || "").slice(0, 100)} »${r.done && r.done.length ? ` ↳ ${r.done.join(" ; ")}` : ""}`);
    if (r.reply) await say(r.reply);
  } catch (e) { log("Vocal non traité :", e); }
}

// ---------- Assistant G37 (privé, ou « ? » dans Ring Fram Local Team) ----------
const queues = new Map(); // une personne à la fois, dans l'ordre de ses messages
function enqueue(key, job) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(job).catch((e) => log("Assistant :", e)).finally(() => { if (queues.get(key) === next) queues.delete(key); });
  queues.set(key, next);
}

async function askAssistant(m, { user, name, channel, replyJid, text }) {
  const msg = unwrap(m.message);
  const ctx = contextOf(m.message);
  const quoted = ctx?.quotedMessage ? textOf(ctx.quotedMessage) : null;
  const body = { user, name, channel, phone: phoneOf(m), member: isMember(user, m.key.remoteJidAlt, m.key.senderPn, m.key.participantPn, m.key.participant), text, quoted };
  try {
    if (msg.imageMessage) {
      if (sizeOf(msg.imageMessage) > 8 * 1024 * 1024) { await send(replyJid, { text: "📷 Photo trop lourde, envoie-la en qualité normale." }, { quoted: m }); return; }
      const { data, mime } = await shrink(await download(m), msg.imageMessage.mimetype);
      body.image = data.toString("base64"); body.imageMime = mime;
    } else if (msg.audioMessage) {
      if (sizeOf(msg.audioMessage) > 10 * 1024 * 1024) { await send(replyJid, { text: "🎤 Note vocale trop longue (2 à 3 minutes maximum)." }, { quoted: m }); return; }
      body.audio = Buffer.from(await download(m)).toString("base64"); body.audioMime = (msg.audioMessage.mimetype || "audio/ogg").split(";")[0];
    }
  } catch (e) { log("Média non téléchargé :", e); }
  try { await sock.sendPresenceUpdate("composing", replyJid); } catch {}
  let reply;
  try { reply = (await api("POST", "chat", body, 130_000)).reply; }
  catch (e) { log("Assistant :", e); reply = "⚠️ Je n'arrive pas à répondre pour l'instant. Réessaie dans quelques minutes."; }
  try { await sock.sendPresenceUpdate("paused", replyJid); } catch {}
  if (reply) await send(replyJid, { text: reply }, { quoted: m });
  log(`${channel === "group" ? "Assistant (groupe)" : "Assistant (privé)"} | ${name} : ${(text || (body.image ? "[photo]" : body.audio ? "[vocal]" : "")).replace(/\s+/g, " ").slice(0, 80)}`);
}

async function handlePrivate(m, jid) {
  const msg = unwrap(m.message);
  const text = textOf(m.message).trim();
  if (!text && !msg?.imageMessage && !msg?.audioMessage) return;
  const name = m.pushName || userPart(jid);
  if (/^![a-z]/i.test(text) && !msg.imageMessage) {
    try {
      const r = /^!rapport\b/i.test(text) ? { reply: (await api("GET", "report")).text } : await api("POST", "command", { text });
      if (r.reply) await send(jid, { text: r.reply }, { quoted: m });
    } catch (e) { log("Commande (privé) :", e); }
    return;
  }
  enqueue(jid, () => askAssistant(m, { user: jid, name, channel: "private", replyJid: jid, text }));
}

// ---------- Groupes ----------
let lastGroupsKey = "";
let groupsTimer = null;
async function loadGroups() {
  if (!sock || !connected) return;
  const all = await sock.groupFetchAllParticipating();
  const ro = Array.isArray(cfg.readOnlyGroups) ? cfg.readOnlyGroups : String(cfg.readOnlyGroups || "").split(/[,;\n]/);
  const wanted = new Map([...ro, cfg.reportGroup].map((n) => String(n || "").trim()).filter(Boolean).map((n) => [norm(n), n]));
  const ids = new Map();
  const members = new Set();
  let report = null;
  for (const [jid, g] of Object.entries(all)) {
    if (!wanted.has(norm(g.subject))) continue;
    ids.set(jid, g.subject);
    for (const p of g.participants || []) for (const k of [p.id, p.lid, p.jid, p.phoneNumber]) if (k) members.add(userPart(k));
    if (norm(g.subject) === norm(cfg.reportGroup)) report = jid;
  }
  // On ne remplace la liste que si on a vraiment lu quelque chose (une lecture vide = coupure, pas un départ des groupes).
  if (ids.size || !groupIds.size) { groupIds = ids; reportJid = report; memberIds = members; }
  const found = [...groupIds.values()];
  const key = [...groupIds.keys()].sort().join("|");
  if (key === lastGroupsKey) return;
  lastGroupsKey = key;
  log(`Groupes suivis : ${found.length ? found.join(", ") : "aucun"}`);
  for (const [n, name] of wanted) if (!found.some((f) => norm(f) === n)) log(`⚠️ Groupe introuvable : « ${name} » — le numéro robot doit en être membre, avec ce nom exact.`);
}
function scheduleLoadGroups() {
  clearTimeout(groupsTimer);
  groupsTimer = setTimeout(() => loadGroups().catch((e) => log("Lecture des groupes :", e)), 30_000);
}
// Relecture des groupes : au démarrage et quand WhatsApp signale un changement (groups.update / upsert).
// Plus de relecture toutes les heures : WhatsApp répondait « rate-overlimit » à chaque fois (risque de restriction du numéro).
// Filet de sécurité : une relecture toutes les 12 h seulement.
setInterval(() => loadGroups().catch((e) => log("Lecture des groupes :", e)), 12 * 60 * 60_000);

// ---------- Connexion WhatsApp ----------
let generation = 0;         // numéro de la connexion en cours : les événements des anciennes sont ignorés
let restartTimer = null;
let starting = false;
let failures = 0;           // échecs de suite : attente 5 s → 10 → 20 → … → 5 min
let lastActivity = Date.now();
let pairingTries = 0;
let wasEverOpen = false;

function restart(delayMs, why) {
  clearTimeout(restartTimer);
  log(`Reconnexion dans ${Math.round(delayMs / 1000)} s${why ? ` (${why})` : ""}.`);
  restartTimer = setTimeout(() => start().catch((e) => { log("Redémarrage :", e); restart(30_000, "erreur au redémarrage"); }), delayMs);
}

// Chien de garde : WhatsApp n'a rien dit (ni message, ni battement) depuis 4 min alors qu'on se croit connecté → on relance.
setInterval(() => {
  if (!connected || starting) return;
  if (Date.now() - lastActivity > 60 * 60_000) {
    log("⚠️ Plus aucun signe de WhatsApp depuis 1 h : connexion considérée morte.");
    connected = false;
    try { sock?.end(undefined); } catch {}
    restart(3000, "chien de garde");
  }
}, 30_000);

async function requestCode(me, gen) {
  // On attend que la ligne soit stable, puis on demande UN code. Jamais deux demandes à la suite sur la même connexion.
  await sleep(4000);
  if (gen !== generation) return;
  pairingTries++;
  if (pairingTries > 6) {
    log("⛔ 6 codes demandés sans succès. WhatsApp bloque sans doute les essais pour un moment.");
    log("   Attends 30 minutes, vérifie que le numéro dans config.json est bien celui du téléphone du robot, puis relance 1-demarrer.bat.");
    await telegram("⛔ association impossible après 6 essais : vérifier le numéro, attendre 30 min");
    process.exit(2);
  }
  try {
    const code = await me.requestPairingCode(String(cfg.phone).replace(/\D/g, ""));
    const pretty = code.match(/.{1,4}/g).join("-");
    log("════════════════════════════════════════");
    log(`CODE D'ASSOCIATION : ${pretty}   (essai ${pairingTries}/6 — valable environ 3 min)`);
    log(`Numéro du robot : +${String(cfg.phone).replace(/\D/g, "")} — le code ne marche QUE dans le WhatsApp de ce numéro.`);
    log("Téléphone du robot : WhatsApp → ⋮ → Appareils connectés → Connecter un appareil");
    log("→ « Connecter avec le numéro de téléphone à la place » → tape ce code.");
    log("════════════════════════════════════════");
    try { fs.writeFileSync(CODE_FILE, `Code d'association WhatsApp : ${pretty}\nDemandé le ${localNow().toISOString().slice(0, 19).replace("T", " ")} (heure du Bénin), valable ~3 min.\n`); } catch {}
    await telegram(`code d'association WhatsApp : ${pretty}`);
  } catch (e) { log("Code d'association impossible :", e); }
}

async function start() {
  if (starting) return;
  starting = true;
  const gen = ++generation;
  connected = false;
  clearTimeout(restartTimer);
  try {
    if (sock) { try { sock.ev.removeAllListeners(); } catch {} try { sock.end(undefined); } catch {} sock = null; await sleep(1500); }
    const before = sessionState();
    if (before.exists && !before.registered) { archiveSession("association précédente jamais terminée"); }
    const fresh = !sessionState().exists;
    if (fresh) { pairingTries = 0; log("Aucune session WhatsApp sur le disque : une association va être demandée."); }
    else log(`Session trouvée (${before.me ? "numéro " + userPart(before.me) : "associée"}) : reconnexion.`);

    const { state, saveCreds } = await B.useMultiFileAuthState(AUTH_DIR);
    const { version } = await B.fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    if (gen !== generation) return;
    const auth = B.makeCacheableSignalKeyStore
      ? { creds: state.creds, keys: B.makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })) }
      : state;
    let codeAsked = false;
    sock = B.makeWASocket({
      version, auth, logger: pino({ level: "silent" }),
      browser: B.Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 30_000,
      keepAliveIntervalMs: 25_000,
      defaultQueryTimeoutMs: 60_000,
      qrTimeout: 180_000,
      generateHighQualityLinkPreview: false,
      // Les anciens messages non déchiffrables ne bloquent rien : on ne garde pas d'historique.
      getMessage: async () => undefined,
    });
    const me = sock;
    // Chaque paquet recu de WhatsApp (dont les reponses aux battements toutes les 25 s) prouve que la connexion vit.
    try { sock.ws.on("frame", () => { if (gen === generation) lastActivity = Date.now(); }); } catch {}
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (u) => {
      if (gen !== generation) return;
      lastActivity = Date.now();
      const { connection, lastDisconnect, qr, receivedPendingNotifications, isNewLogin } = u;
      if (isNewLogin) log("Association acceptée par le téléphone ✔ (WhatsApp va demander un redémarrage, c'est normal).");

      if (qr && !me.authState.creds.registered) {
        if ((cfg.linkMethod || "code") === "qr") {
          try {
            const QR = require("qrcode");
            await QR.toFile(QR_FILE, qr, { width: 600, margin: 3 });
            if (!codeAsked) {
              console.log(await QR.toString(qr, { type: "terminal", small: true }));
              log(`QR CODE prêt : ouvre ${QR_FILE} et scanne-le avec le téléphone du robot (Appareils connectés).`);
              await telegram("le robot attend d'être associé : ouvre qr.png sur le VPS et scanne-le");
            }
            codeAsked = true;
          } catch (e) { log("QR code impossible (module qrcode absent ? npm.cmd install qrcode) :", e); }
        } else if (!codeAsked) {
          codeAsked = true;
          await requestCode(me, gen);
        }
      }

      if (connection === "open") {
        connected = true;
        wasEverOpen = true;
        failures = 0;
        pairingTries = 0;
        try { fs.unlinkSync(QR_FILE); } catch {}
        try { fs.unlinkSync(CODE_FILE); } catch {}
        log(`✅ Connecté à WhatsApp (numéro ${userPart(me.user?.id) || "?"}).`);
        lastGroupsKey = "";
        await loadGroups().catch((e) => log("Lecture des groupes :", e));
        await flushPending().catch(() => {});
        await telegram("connecté ✅");
      }
      if (receivedPendingNotifications) log("Messages en attente reçus.");

      if (connection === "close") {
        connected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        const R = B.DisconnectReason;
        log(`Connexion fermée : ${reasonText(code)}.`);

        if (code === (R.restartRequired ?? 515)) { restart(1500, "redémarrage demandé par WhatsApp"); return; }

        if (code === (R.loggedOut ?? 401) || code === (R.badSession ?? 500) || code === (R.forbidden ?? 403)) {
          // Session morte : on l'archive et on attend que WhatsApp ait vraiment retiré l'appareil
          // AVANT de demander un code (sinon le code est refusé : « Impossible de connecter l'appareil »).
          const wait = code === (R.forbidden ?? 403) ? 30 * 60_000 : wasEverOpen ? 15_000 : 45_000;
          archiveSession(reasonText(code));
          wasEverOpen = false;
          if (code === (R.forbidden ?? 403)) log("Le numéro semble bloqué par WhatsApp : attente de 30 min avant un nouvel essai.");
          else log("Sur le téléphone du robot, retire les anciens appareils « Chrome / Ubuntu » restés dans « Appareils connectés » si tu en vois.");
          await telegram("❌ session WhatsApp perdue — un nouveau code va être demandé (voir bot.log)");
          restart(wait, "nouvelle association");
          return;
        }
        if (code === (R.connectionReplaced ?? 440)) {
          log("⚠️ Une AUTRE copie du robot utilise cette session (fenêtre oubliée ou démarrage automatique). Ferme-la : 3-arreter.bat.");
          await telegram("⚠️ deux copies du robot tournent en même temps sur le VPS");
          restart(120_000, "conflit de copies");
          return;
        }
        if (code === (R.multideviceMismatch ?? 411)) { archiveSession("multi-appareils"); restart(10_000, "multi-appareils"); return; }

        failures++;
        const wait = Math.min(5000 * 2 ** Math.min(failures - 1, 6), 5 * 60_000);
        if (wasEverOpen && failures === 1) await telegram(`connexion perdue (${reasonText(code)}), reconnexion…`);
        restart(wait, `échec ${failures}`);
      }
    });

    sock.ev.on("groups.update", scheduleLoadGroups);
    sock.ev.on("groups.upsert", scheduleLoadGroups);
    sock.ev.on("presence.update", () => { lastActivity = Date.now(); });
    sock.ev.on("messages.update", () => { lastActivity = Date.now(); });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (gen !== generation) return;
      lastActivity = Date.now();
      if (type !== "notify" && type !== "append") return;
      for (const m of messages) {
        try { await handleMessage(m); } catch (e) { log("Message ignoré (erreur) :", e); }
      }
    });
  } catch (e) {
    log("Démarrage de la connexion impossible :", e);
    restart(15_000, "erreur de démarrage");
  } finally { starting = false; }
}

async function handleMessage(m) {
  const jid = m.key?.remoteJid;
  if (!jid || m.key.fromMe || !m.message) return;
  if (jid === "status@broadcast") return;
  const ts = Number(m.messageTimestamp?.toString?.() ?? m.messageTimestamp) || Math.floor(Date.now() / 1000);
  if (/@(s\.whatsapp\.net|lid)$/.test(jid)) {
    if (Date.now() / 1000 - ts <= 30 * 60) await handlePrivate(m, jid);
    return;
  }
  if (!groupIds.has(jid)) return;
  const text = textOf(m.message).trim();
  const inner = unwrap(m.message) || {};
  const image = inner.imageMessage;
  const audio = inner.audioMessage;
  const doc = inner.documentMessage;
  const pdf = doc && (/pdf/i.test(doc.mimetype || "") || /\.pdf$/i.test(doc.fileName || ""));
  if (!text && !image && !audio && !pdf) return;
  if (Date.now() / 1000 - ts > 12 * 3600) return; // vieux messages rejoués à la connexion
  const group = groupIds.get(jid);
  const sender = m.pushName || userPart(m.key.participant);

  if (pdf) { await handlePdf(m, jid, group, sender, text, ts); return; }
  if (audio) { await handleVoice(m, jid, group, sender, ts); return; }
  if (/^\?\s*\S/.test(text) && jid === reportJid) {
    const user = m.key.participant || jid;
    enqueue(user, () => askAssistant(m, { user, name: sender, channel: "group", replyJid: jid, text }));
    return;
  }
  if (/^!rapport\b/i.test(text)) { await sendReport(`demandé par ${sender}`); return; }
  if (/^![a-z]/i.test(text) && !image) {
    try { const r = await api("POST", "command", { text }); if (r.reply) await say(r.reply); log(`${group} | ${sender} : commande ${text.slice(0, 40)}`); }
    catch (e) { log("Commande :", e); }
    return;
  }
  if (image) { await handlePhoto(m, jid, group, sender, text, ts); return; }

  const ctx = contextOf(m.message);
  const quoted = ctx?.quotedMessage ? textOf(ctx.quotedMessage) : null;
  const item = { msgId: `${jid}:${m.key.id}`, group, text, quoted, sender, phone: phoneOf(m), at: ts };
  log(`${group} | ${sender} : ${text.replace(/\s+/g, " ").slice(0, 120)}`);
  if (!(await deliver(item))) { pending.push(item); writeJson(PENDING_FILE, pending); }
}

// ---------- Lancement ----------
process.on("unhandledRejection", (e) => log("Erreur (promesse) :", e?.message || e));
process.on("uncaughtException", (e) => { log("Erreur grave :", e?.stack || e); setTimeout(() => process.exit(1), 500); });
takeLock();
log("Démarrage du robot WhatsApp G37 (v3)…");
if (!cfg.apiKey || /clé secrète/i.test(cfg.apiKey)) { log("⛔ config.json : apiKey manquante (clé wa.key de G37)."); process.exit(1); }
if (!/^\d{10,15}$/.test(String(cfg.phone || "").replace(/\D/g, ""))) { log("⛔ config.json : « phone » doit être le numéro complet du robot, ex. 2290168869634."); process.exit(1); }
loadBaileys().then(start).catch((e) => { log("Démarrage impossible :", e); process.exit(1); });
