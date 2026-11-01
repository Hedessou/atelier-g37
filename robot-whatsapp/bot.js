// Atelier G37 — numéro robot WhatsApp.
// • Lit les groupes « Spinning Shift Supervisors » (lecture seule) et « Ring Fram Local Team ».
// • Envoie chaque message à G37, qui le range dans Pannes / Travaux (et clôture quand « it's running », « c'est bon »…).
// • Chaque jour de lundi à samedi à 8h, poste le rapport dans « Ring Fram Local Team ».
// • Dans ce groupe, « !rapport » renvoie le rapport tout de suite, et « ? question » interroge l'assistant G37.
// • En privé avec le numéro robot : assistant technique (questions, photos d'écran, notes vocales).
// • v2 (01/11/2026) : personnes autorisées → modifications de l'app avec confirmation ; question de 16h30 (note vocale en privé).
// • Notes vocales des groupes : transcrites puis traitées comme un message écrit.
const fs = require("fs");
const path = require("path");
const pino = require("pino");
// Baileys est chargé au démarrage (fonctionne avec les versions 6 et 7 de la bibliothèque).
let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, downloadMediaMessage;
async function loadBaileys() {
  const B = await import("@whiskeysockets/baileys");
  const pick = (k) => B[k] ?? B.default?.[k];
  makeWASocket = pick("makeWASocket") ?? (typeof B.default === "function" ? B.default : B.default?.default);
  useMultiFileAuthState = pick("useMultiFileAuthState");
  DisconnectReason = pick("DisconnectReason");
  fetchLatestBaileysVersion = pick("fetchLatestBaileysVersion");
  Browsers = pick("Browsers");
  downloadMediaMessage = pick("downloadMediaMessage");
  if (typeof makeWASocket !== "function") throw new Error("bibliothèque Baileys introuvable — lance « npm install »");
}

const DIR = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
const STATE_FILE = path.join(DIR, "state.json");
const PENDING_FILE = path.join(DIR, "pending.json");
const LOG_FILE = path.join(DIR, "bot.log");

// ---------- Journal ----------
function log(...args) {
  const line = `[${localNow().toISOString().replace("T", " ").slice(0, 19)}] ${args.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
    if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + ".old");
  } catch {}
}

// Heure du Bénin (UTC+1) exprimée dans un objet Date « décalé » : on lit ses champs UTC.
function localNow() { return new Date(Date.now() + (cfg.utcOffsetHours ?? 1) * 3600_000); }
const todayStr = () => localNow().toISOString().slice(0, 10);

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ---------- Alerte Telegram (facultative) ----------
async function telegram(text) {
  if (!cfg.telegramBotToken || !cfg.telegramChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.telegramChatId, text: `G37 WhatsApp : ${text}` }),
    });
  } catch (e) { log("Telegram :", e.message); }
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
    // Confirmation (graissage, magasin) ou question : réponse dans le groupe autorisé.
    if (r.reply) await say(r.reply);
    return true;
  } catch (e) {
    log(`Envoi à G37 impossible (${e.message}) — nouvel essai plus tard.`);
    return false;
  }
}
async function flushPending() {
  if (!pending.length) return;
  const keep = [];
  for (const item of pending) if (!(await deliver(item))) keep.push(item);
  pending = keep.slice(-500);
  writeJson(PENDING_FILE, pending);
}
setInterval(flushPending, 60_000);

// Numéro de téléphone de l'expéditeur (WhatsApp cache parfois le numéro derrière un identifiant « @lid »).
function phoneOf(m) {
  const k = m.key || {};
  for (const j of [k.senderPn, k.participantPn, k.remoteJidAlt, k.participantAlt, k.participant, k.remoteJid]) {
    if (j && /@s\.whatsapp\.net$/.test(String(j))) return String(j).split("@")[0].split(":")[0];
  }
  return null;
}

// Note vocale : WAV (envoyé par G37) → OGG Opus, le format des notes vocales WhatsApp (module ffmpeg-static).
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

// Envoi d'un message préparé par G37 : dans le groupe, ou en privé (to_phone), avec note vocale éventuelle.
async function deliverOutbox(m) {
  const jid = m.to_phone ? `${String(m.to_phone).replace(/\D/g, "")}@s.whatsapp.net` : reportJid;
  if (!sock || !connected || !jid) return false;
  try {
    if (m.voice) {
      const ogg = await toVoiceNote(m.voice);
      if (ogg) await sock.sendMessage(jid, { audio: ogg, mimetype: "audio/ogg; codecs=opus", ptt: true }).catch((e) => log("Note vocale non envoyée :", e.message));
    }
    if (m.text) await sock.sendMessage(jid, { text: m.text });
    if (m.to_phone) log(`Message privé envoyé à ${m.to_phone}${m.voice ? " (avec note vocale)" : ""}`);
    return true;
  } catch (e) { log("Envoi WhatsApp impossible :", e.message); return false; }
}

// Envoi dans « Ring Fram Local Team » (le seul groupe où le robot écrit).
async function say(text) {
  if (!sock || !connected || !reportJid || !text) return false;
  try { await sock.sendMessage(reportJid, { text }); return true; } catch (e) { log("Envoi WhatsApp impossible :", e.message); return false; }
}

// Messages préparés par G37 (confirmation « Fait », rappels, stock bas, pannes répétitives).
// Cet appel sert aussi de « je suis vivant » : sans lui pendant 20 min, l'admin reçoit une alerte sur son téléphone.
// Il n'est fait QUE si WhatsApp est vraiment connecté : robot déconnecté = alerte (31/10/2026).
let outboxBusy = false;
setInterval(async () => {
  if (outboxBusy || !sock || !connected || !reportJid) return;
  outboxBusy = true;
  try {
    const { messages } = await api("GET", "outbox");
    const sent = [];
    for (const m of messages || []) if (await deliverOutbox(m)) sent.push(m.id);
    if (sent.length) { await api("POST", "outbox-ack", { ids: sent }); log(`Messages G37 envoyés : ${sent.length}`); }
  } catch (e) { log("Boîte d'envoi G37 :", e.message); }
  finally { outboxBusy = false; }
}, 30_000);

// Rappels et détection des pannes répétitives, toutes les 10 minutes.
setInterval(() => api("GET", "tick", null, 60_000).catch((e) => log("Contrôle périodique :", e.message)), 10 * 60_000);

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
  return m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo || m.documentMessage?.contextInfo || null;
}

// ---------- Rapport du matin ----------
let sock = null;
let groupIds = new Map(); // jid -> nom du groupe
let reportJid = null;
let reportBusy = false;

async function sendReport(reason) {
  if (!sock || !connected || !reportJid || reportBusy) return false;
  reportBusy = true;
  try {
    const { text } = await api("GET", "report");
    await sock.sendMessage(reportJid, { text });
    log(`Rapport envoyé (${reason}).`);
    return true;
  } catch (e) {
    log("Rapport non envoyé :", e.message);
    await telegram(`rapport du matin non envoyé (${e.message})`);
    return false;
  } finally { reportBusy = false; }
}

// Vérifie toutes les 30 s : jour prévu, 8h passées (jusqu'à midi pour rattraper une coupure), pas encore envoyé aujourd'hui.
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
// Photo réduite (1600 px max, JPEG) : 10 fois plus légère, toujours lisible, lecture beaucoup plus rapide.
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
  return downloadMediaMessage(m, "buffer", {}, { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage });
}
const sizeOf = (media) => Number(media?.fileLength?.toString?.() ?? media?.fileLength ?? 0);

// ---------- Photos : fiches « Count change slip » ----------
async function handlePhoto(m, jid, group, sender, caption, ts) {
  const img = unwrap(m.message).imageMessage;
  const size = Number(img.fileLength?.toString?.() ?? img.fileLength ?? 0);
  if (size > 8 * 1024 * 1024) { log(`${group} | ${sender} : photo trop lourde, ignorée`); return; }
  log(`${group} | ${sender} : 📷 photo${caption ? ` (« ${caption.slice(0, 60)} »)` : ""} — lecture…`);
  let buffer;
  try { buffer = await download(m); } catch (e) { log("Photo non téléchargée :", e.message); return; }
  const { data, mime } = await shrink(buffer, img.mimetype);
  const body = { msgId: `${jid}:${m.key.id}`, group, sender, at: ts, caption, mime, image: data.toString("base64") };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await api("POST", "slip", body, 120_000);
      if (r.done && r.done.length) log(`↳ ${group} | ${r.done.join(" ; ")}`);
      else if (r.action) log(`↳ ${group} | photo : ${r.action}`);
      // Pignons indisponibles, déjà montés, ou test : message dans le groupe autorisé.
      if (r.reply) await say(r.reply);
      return;
    } catch (e) {
      log(`Lecture de la photo impossible (essai ${attempt}/3) : ${e.message}`);
      await new Promise((ok) => setTimeout(ok, 20_000));
    }
  }
}

// ---------- Rapports PDF de quart (production) ----------
async function handlePdf(m, jid, group, sender, caption, ts) {
  const doc = unwrap(m.message).documentMessage;
  const fileName = doc.fileName || doc.title || "rapport.pdf";
  if (sizeOf(doc) > 15 * 1024 * 1024) { log(`${group} | ${sender} : PDF trop lourd, ignoré`); return; }
  log(`${group} | ${sender} : 📄 ${fileName} — lecture…`);
  let buffer;
  try { buffer = await download(m); } catch (e) { log("PDF non téléchargé :", e.message); return; }
  const body = { msgId: `${jid}:${m.key.id}`, group, sender, phone: phoneOf(m), at: ts, caption, fileName, pdf: Buffer.from(buffer).toString("base64") };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await api("POST", "report-pdf", body, 150_000);
      if (r.duplicate) return;
      if (r.ok) { log(`↳ ${group} | rapport ${r.ignored ? `ignoré (${r.ignored})` : `lu : ${r.rows} métiers, ${r.faults} panne(s)`}`); return; }
      log(`Rapport non lu (essai ${attempt}/3) : ${r.error}`);
      if (r.quota) return;
    } catch (e) { log(`Rapport non lu (essai ${attempt}/3) : ${e.message}`); }
    await new Promise((ok) => setTimeout(ok, 30_000));
  }
}

// ---------- Notes vocales dans les groupes ----------
async function handleVoice(m, jid, group, sender, ts) {
  const audio = unwrap(m.message).audioMessage;
  if (sizeOf(audio) > 10 * 1024 * 1024) { log(`${group} | ${sender} : vocal trop long, ignoré`); return; }
  let buffer;
  try { buffer = await download(m); } catch (e) { log("Vocal non téléchargé :", e.message); return; }
  const ctx = contextOf(m.message);
  const quoted = ctx?.quotedMessage ? textOf(ctx.quotedMessage) : null;
  const body = { msgId: `${jid}:${m.key.id}`, group, sender, at: ts, quoted, mime: (audio.mimetype || "audio/ogg").split(";")[0], audio: Buffer.from(buffer).toString("base64") };
  try {
    const r = await api("POST", "voice", body, 120_000);
    log(`${group} | ${sender} : 🎤 « ${String(r.heard || "").slice(0, 100)} »${r.done && r.done.length ? ` ↳ ${r.done.join(" ; ")}` : ""}`);
    if (r.reply) await say(r.reply);
  } catch (e) { log("Vocal non traité :", e.message); }
}

// ---------- Assistant G37 (privé, ou « ? » dans Ring Fram Local Team) ----------
let memberIds = new Set(); // membres des deux groupes (numéro et identifiant WhatsApp)
const userPart = (j) => String(j || "").split("@")[0].split(":")[0];
function isMember(...ids) { return ids.some((j) => j && memberIds.has(userPart(j))); }

const queues = new Map(); // une personne à la fois, dans l'ordre de ses messages
function enqueue(key, job) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(job).catch((e) => log("Assistant :", e.message)).finally(() => { if (queues.get(key) === next) queues.delete(key); });
  queues.set(key, next);
}

async function askAssistant(m, { user, name, channel, replyJid, text }) {
  const msg = unwrap(m.message);
  const ctx = contextOf(m.message);
  const quoted = ctx?.quotedMessage ? textOf(ctx.quotedMessage) : null;
  const body = { user, name, channel, phone: phoneOf(m), member: isMember(user, m.key.remoteJidAlt, m.key.senderPn, m.key.participantPn, m.key.participant), text, quoted };
  try {
    if (msg.imageMessage) {
      if (sizeOf(msg.imageMessage) > 8 * 1024 * 1024) { await sock.sendMessage(replyJid, { text: "📷 Photo trop lourde, envoie-la en qualité normale." }, { quoted: m }); return; }
      const { data, mime } = await shrink(await download(m), msg.imageMessage.mimetype);
      body.image = data.toString("base64"); body.imageMime = mime;
    } else if (msg.audioMessage) {
      if (sizeOf(msg.audioMessage) > 10 * 1024 * 1024) { await sock.sendMessage(replyJid, { text: "🎤 Note vocale trop longue (2 à 3 minutes maximum)." }, { quoted: m }); return; }
      body.audio = Buffer.from(await download(m)).toString("base64"); body.audioMime = (msg.audioMessage.mimetype || "audio/ogg").split(";")[0];
    }
  } catch (e) { log("Média non téléchargé :", e.message); }
  try { await sock.sendPresenceUpdate("composing", replyJid); } catch {}
  let reply;
  try { reply = (await api("POST", "chat", body, 130_000)).reply; }
  catch (e) { log("Assistant :", e.message); reply = "⚠️ Je n'arrive pas à répondre pour l'instant. Réessaie dans quelques minutes."; }
  try { await sock.sendPresenceUpdate("paused", replyJid); } catch {}
  if (reply) await sock.sendMessage(replyJid, { text: reply }, { quoted: m });
  log(`${channel === "group" ? "Assistant (groupe)" : "Assistant (privé)"} | ${name} : ${(text || (body.image ? "[photo]" : body.audio ? "[vocal]" : "")).replace(/\s+/g, " ").slice(0, 80)}`);
}

async function handlePrivate(m, jid) {
  const msg = unwrap(m.message);
  const text = textOf(m.message).trim();
  if (!text && !msg?.imageMessage && !msg?.audioMessage) return;
  const name = m.pushName || userPart(jid);
  // Commandes aussi en privé : !rapport, !mc 22, !stock G41, !aide.
  if (/^![a-z]/i.test(text) && !msg.imageMessage) {
    try {
      const r = /^!rapport\b/i.test(text) ? { reply: (await api("GET", "report")).text } : await api("POST", "command", { text });
      if (r.reply) await sock.sendMessage(jid, { text: r.reply }, { quoted: m });
    } catch (e) { log("Commande (privé) :", e.message); }
    return;
  }
  enqueue(jid, () => askAssistant(m, { user: jid, name, channel: "private", replyJid: jid, text }));
}

// ---------- Connexion WhatsApp ----------
const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
let pairingAsked = false;
let wasOpen = false;
let connected = false;     // vrai seulement quand WhatsApp est réellement connecté
let generation = 0;        // numéro de la connexion en cours : les événements des anciennes sont ignorés
let restartTimer = null;
let failures = 0;          // échecs de suite : l'attente avant reconnexion augmente (5 s → 5 min)
const QR_FILE = path.join(DIR, "qr.png");
function restart(delayMs) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => start().catch((e) => { log("Redémarrage :", e.message); restart(30_000); }), delayMs);
}

async function loadGroups() {
  const all = await sock.groupFetchAllParticipating();
  const wanted = new Map([...cfg.readOnlyGroups, cfg.reportGroup].map((n) => [norm(n), n]));
  groupIds = new Map();
  reportJid = null;
  const members = new Set();
  for (const [jid, g] of Object.entries(all)) {
    if (!wanted.has(norm(g.subject))) continue;
    groupIds.set(jid, g.subject);
    for (const p of g.participants || []) for (const k of [p.id, p.lid, p.jid, p.phoneNumber]) if (k) members.add(userPart(k));
    if (norm(g.subject) === norm(cfg.reportGroup)) reportJid = jid;
  }
  memberIds = members;
  const found = [...groupIds.values()];
  const key = [...groupIds.keys()].sort().join("|");
  if (key === lastGroupsKey) return; // rien de changé : on ne répète pas le journal
  lastGroupsKey = key;
  log(`Groupes suivis : ${found.length ? found.join(", ") : "aucun"}`);
  for (const [n, name] of wanted) if (!found.some((f) => norm(f) === n)) log(`⚠️ Groupe introuvable : « ${name} » — le numéro robot doit en être membre, avec ce nom exact.`);
}
// Les mises à jour de groupes arrivent en rafale : une seule relecture, 30 s après la dernière.
let lastGroupsKey = "";
let groupsTimer = null;
function scheduleLoadGroups() {
  clearTimeout(groupsTimer);
  groupsTimer = setTimeout(() => loadGroups().catch((e) => log("Lecture des groupes :", e.message)), 30_000);
}

async function start() {
  // Une seule connexion à la fois : on ferme proprement l'ancienne avant d'en ouvrir une nouvelle.
  const gen = ++generation;
  connected = false;
  if (sock) { try { sock.ev.removeAllListeners(); } catch {} try { sock.end(undefined); } catch {} }
  const { state, saveCreds } = await useMultiFileAuthState(path.join(DIR, "auth"));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  if (gen !== generation) return;
  pairingAsked = false;
  let qrShown = false;
  sock = makeWASocket({
    version, auth: state, logger: pino({ level: "silent" }),
    browser: Browsers.ubuntu("Chrome"), markOnlineOnConnect: false, syncFullHistory: false,
    qrTimeout: 180_000, // la demande d'association reste ouverte 3 min : le code ne change pas pendant ce temps
  });
  const me = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (gen !== generation) return; // événement d'une ancienne connexion
    // Association : code à 8 caractères par défaut (un seul téléphone suffit). « "linkMethod": "qr" » dans config.json = QR code.
    if (qr && !me.authState.creds.registered) {
      if ((cfg.linkMethod || "code") === "qr") {
        try {
          const QR = require("qrcode");
          await QR.toFile(QR_FILE, qr, { width: 600, margin: 3 });
          if (!qrShown) {
            console.log(await QR.toString(qr, { type: "terminal", small: true }));
            log("════════════════════════════════════════");
            log(`QR CODE prêt : ouvre le fichier ${QR_FILE} (il se renouvelle toutes les 20 s).`);
            log("Téléphone du numéro robot : WhatsApp → ⋮ → Appareils connectés → Connecter un appareil → scanne le QR.");
            log("════════════════════════════════════════");
            await telegram("le robot attend d'être associé : ouvre qr.png sur le VPS et scanne-le avec le téléphone du numéro robot");
          }
          qrShown = true;
        } catch (e) { log("QR code impossible (module qrcode absent ? tape : npm.cmd install qrcode) :", e.message); }
      } else if (!pairingAsked) {
        pairingAsked = true;
        try {
          await new Promise((ok) => setTimeout(ok, 3000)); // laisse la connexion se stabiliser
          if (gen !== generation) return;
          const code = await me.requestPairingCode(String(cfg.phone).replace(/\D/g, ""));
          log("════════════════════════════════════════");
          log(`CODE D'ASSOCIATION : ${code.match(/.{1,4}/g).join("-")}  (valable 3 min)`);
          log("Téléphone du numéro robot : WhatsApp → ⋮ → Appareils connectés → Connecter un appareil");
          log("→ « Connecter avec le numéro de téléphone » → tape ce code.");
          log("════════════════════════════════════════");
          try { fs.writeFileSync(path.join(DIR, "CODE.txt"), `Code d'association WhatsApp : ${code.match(/.{1,4}/g).join("-")}\nValable 3 min, demandé le ${localNow().toISOString().slice(0, 19).replace("T", " ")}\n`); } catch {}
          await telegram(`code d'association WhatsApp : ${code}`);
        } catch (e) { log("Code d'association impossible :", e.message); }
      }
    }
    if (connection === "open") {
      connected = true;
      wasOpen = true;
      failures = 0;
      try { fs.unlinkSync(QR_FILE); } catch {}
      try { fs.unlinkSync(path.join(DIR, "CODE.txt")); } catch {}
      log("✅ Connecté à WhatsApp.");
      lastGroupsKey = "";
      await loadGroups().catch((e) => log("Lecture des groupes :", e.message));
      await flushPending();
      await telegram("connecté ✅");
    }
    if (connection === "close") {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === (DisconnectReason?.loggedOut ?? 401)) {
        // Appareil retiré côté téléphone : on met l'ancienne session de côté et on redemande une association.
        log("❌ Le numéro robot a été déconnecté de WhatsApp — nouvelle association dans 5 s.");
        await telegram("❌ déconnecté de WhatsApp — il faut associer le robot à nouveau");
        try { fs.renameSync(path.join(DIR, "auth"), path.join(DIR, `auth-ancien-${Date.now()}`)); } catch {}
        wasOpen = false;
        restart(5000);
        return;
      }
      if (code === (DisconnectReason?.connectionReplaced ?? 440)) {
        log("⚠️ Une AUTRE copie du robot utilise la même session (2 fenêtres ouvertes ?). Ferme-la avec 3-arreter.bat. Nouvel essai dans 2 min.");
        await telegram("⚠️ deux copies du robot tournent en même temps sur le VPS");
        restart(120_000);
        return;
      }
      failures++;
      const wait = Math.min(5000 * 2 ** Math.min(failures - 1, 6), 5 * 60_000);
      log(`Connexion perdue (code ${code ?? "?"}) — reconnexion dans ${Math.round(wait / 1000)} s.`);
      if (wasOpen) await telegram(`connexion perdue (code ${code ?? "?"}), reconnexion…`);
      wasOpen = false;
      restart(wait);
    }
  });

  sock.ev.on("groups.update", scheduleLoadGroups);
  sock.ev.on("groups.upsert", scheduleLoadGroups); // robot ajouté dans un nouveau groupe

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const m of messages) {
      try {
        const jid = m.key?.remoteJid;
        if (!jid || m.key.fromMe || !m.message) continue;
        const ts = Number(m.messageTimestamp?.toString?.() ?? m.messageTimestamp) || Math.floor(Date.now() / 1000);
        // Message privé (pas un groupe, pas un statut) : assistant G37. On ne répond pas aux vieux messages (> 30 min).
        if (/@(s\.whatsapp\.net|lid)$/.test(jid)) {
          if (Date.now() / 1000 - ts <= 30 * 60) await handlePrivate(m, jid);
          continue;
        }
        if (!groupIds.has(jid)) continue;
        const text = textOf(m.message).trim();
        const image = unwrap(m.message)?.imageMessage;
        const audio = unwrap(m.message)?.audioMessage;
        const doc = unwrap(m.message)?.documentMessage;
        const pdf = doc && (/pdf/i.test(doc.mimetype || "") || /\.pdf$/i.test(doc.fileName || ""));
        if (!text && !image && !audio && !pdf) continue;
        if (Date.now() / 1000 - ts > 12 * 3600) continue; // vieux messages rejoués à la connexion
        const group = groupIds.get(jid);
        const sender = m.pushName || String(m.key.participant || "").split("@")[0];

        // Rapport PDF de quart : efficience des ring frames et remarques (pannes).
        if (pdf) { await handlePdf(m, jid, group, sender, text, ts); continue; }

        // Note vocale : transcrite puis enregistrée comme un message écrit.
        if (audio) { await handleVoice(m, jid, group, sender, ts); continue; }

        // « ? question » dans Ring Fram Local Team : l'assistant répond dans le groupe (jamais dans le groupe en lecture seule).
        if (/^\?\s*\S/.test(text) && jid === reportJid) {
          const user = m.key.participant || jid;
          enqueue(user, () => askAssistant(m, { user, name: sender, channel: "group", replyJid: jid, text }));
          continue;
        }

        if (/^!rapport\b/i.test(text)) { await sendReport(`demandé par ${m.pushName || "?"}`); continue; }
        // Autres commandes : !aide, !mc 22, !stock G41 (réponse dans « Ring Fram Local Team »).
        if (/^![a-z]/i.test(text) && !image) {
          try { const r = await api("POST", "command", { text }); if (r.reply) await say(r.reply); log(`${group} | ${sender} : commande ${text.slice(0, 40)}`); }
          catch (e) { log("Commande :", e.message); }
          continue;
        }

        // Photo (fiche « Count change slip ») : G37 la lit, vérifie le stock et peut répondre dans le groupe.
        if (image) { await handlePhoto(m, jid, group, sender, text, ts); continue; }

        const ctx = contextOf(m.message);
        const quoted = ctx?.quotedMessage ? textOf(ctx.quotedMessage) : null;
        const item = { msgId: `${jid}:${m.key.id}`, group, text, quoted, sender, phone: phoneOf(m), at: ts };
        log(`${group} | ${item.sender} : ${text.replace(/\s+/g, " ").slice(0, 120)}`);
        if (!(await deliver(item))) { pending.push(item); writeJson(PENDING_FILE, pending); }
      } catch (e) { log("Message ignoré (erreur) :", e.message); }
    }
  });
}

process.on("unhandledRejection", (e) => log("Erreur :", e?.message || e));
try { fs.writeFileSync(path.join(DIR, "bot.pid"), String(process.pid)); } catch {}
log("Démarrage du robot WhatsApp G37…");
loadBaileys().then(start).catch((e) => { log("Démarrage impossible :", e.message); process.exit(1); });
