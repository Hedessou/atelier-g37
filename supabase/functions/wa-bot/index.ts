// Fonction « wa-bot » d'Atelier G37 : reçoit les messages des groupes WhatsApp (envoyés par le numéro robot du VPS),
// les range dans les sections de l'app, lit les fiches « Count change slip » en photo, et prépare le rapport du matin.
// Routes : POST ingest · POST slip · GET report · GET outbox · POST outbox-ack · POST command · GET tick · GET watchdog · POST dry.
// v2 (01/11/2026) : relecture par l'IA des messages non compris · GET evening (question de 16h30) · POST evening-dry.
// En-tête obligatoire : x-wa-key.
import { addDays, broadcastChanged, config, ddmm, diff, isoDay, machineId, newId, rf, sql, when } from "./db.ts";
import { parseMessage, solutionText, workTitle } from "./parse.ts";
import { chat, knowledge, transcribe } from "./assistant.ts";
import { availableStock, draftOf, fmt2, PER_MACHINE, pct, proposals, RANGE } from "./gears.ts";
import { gemini, QuotaError, quotaMessage } from "./gemini.ts";
import { ackOutbox, command, cycleEntry, stockEntry, takeOutbox, tick, watchdog } from "./features.ts";
import { applyPending, countChangeState, countChangeText, markAsked } from "./countchange.ts";
import { eveningRun, plannedToday } from "./evening.ts";
import { handleReportPdf } from "./reports.ts";
import { learnName, people, personByPhone } from "./people.ts";
import { beninDay } from "./db.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

let keyCache: { v: string; at: number } | null = null;
async function authorized(req: Request): Promise<boolean> {
  const given = req.headers.get("x-wa-key") ?? "";
  if (!given) return false;
  if (!keyCache || Date.now() - keyCache.at > 5 * 60_000) keyCache = { v: await config("wa.key"), at: Date.now() };
  return !!keyCache.v && given === keyCache.v;
}

type Msg = { msgId: string; group: string; sender?: string; text?: string; quoted?: string | null; at?: string | number };
type Meta = { msgId: string; group: string; sender: string; at: Date };

function meta(body: Msg): Meta {
  let at = body.at ? new Date(typeof body.at === "number" && body.at < 1e12 ? body.at * 1000 : body.at) : new Date();
  if (!Number.isFinite(at.getTime()) || at.getTime() > Date.now() + 60_000 || at.getTime() < Date.now() - 7 * 86400000) at = new Date();
  return {
    msgId: String(body.msgId ?? "").slice(0, 120),
    group: String(body.group ?? "").slice(0, 120),
    sender: (String(body.sender ?? "").trim() || "WhatsApp").slice(0, 80),
    at,
  };
}

// Enregistre le message une seule fois (le robot peut renvoyer après une coupure).
async function firstTime(m: Meta, text: string, quoted: string | null): Promise<boolean> {
  const fresh = await sql`INSERT INTO wa_messages (msg_id, group_name, sender, body, quoted, received_at)
    VALUES (${m.msgId}, ${m.group}, ${m.sender}, ${text}, ${quoted}, ${m.at}) ON CONFLICT (msg_id) DO NOTHING RETURNING msg_id`;
  return fresh.length > 0;
}

// Travail « Count change » déjà noté par WhatsApp pour cette machine (texte ou photo) dans les 2 derniers jours.
async function openCountWork(n: number, at: Date) {
  const rows = await sql`SELECT id, title FROM works WHERE machine_no = ${n} AND status = 'todo' AND author_name LIKE 'WhatsApp%'
    AND title LIKE 'Count change%' AND created_at > ${at}::timestamptz - interval '48 hours' ORDER BY created_at DESC LIMIT 1`;
  return rows[0] as { id: string; title: string } | undefined;
}

async function handleText(m: Meta, text: string, quoted: string | null, solution: string | null = null, smart = true): Promise<HandleResult> {
  // Count change fait (« RF 6 count change finish ») ou réponse « 1 / 2 » à la question du robot (27/10/2026).
  const cc = await countChangeText(m, text, quoted);
  if (cc) {
    await sql`UPDATE wa_messages SET action = ${cc.action}, machines = ${cc.machines}, result = ${sql.json({ done: cc.done, reply: cc.reply })} WHERE msg_id = ${m.msgId}`;
    if (cc.done.length) await broadcastChanged();
    return { action: cc.action, machines: cc.machines, title: "", done: cc.done, reply: cc.reply };
  }
  // Magasin (« Arrivé de 2 belt 1600 ») puis graissage / lubrification / schedule (« front rollers greasing mc 1 to 8 »).
  const extra = (await stockEntry(m, text)) ?? (await cycleEntry(m, text));
  if (extra) {
    await sql`UPDATE wa_messages SET action = ${extra.action}, machines = ${extra.machines ?? []}, result = ${sql.json({ done: extra.done, reply: extra.reply ?? null })}
      WHERE msg_id = ${m.msgId}`;
    if (extra.done.length) await broadcastChanged();
    return { action: extra.action, machines: extra.machines ?? [], title: "", done: extra.done, reply: extra.reply ?? null };
  }
  const p = parseMessage(text, quoted);
  const done: string[] = [];
  const confirm: string[] = [];
  const known = p.machines.length
    ? (await sql`SELECT machine_no FROM machines WHERE machine_no = ANY(${p.machines})`).map((r) => Number(r.machine_no))
    : [];
  const machines = p.machines.filter((n) => known.includes(n));

  for (const n of machines) {
    const mid = machineId(n);
    if (p.kind === "fault") {
      const dup = await sql`SELECT id FROM failures WHERE machine_id = ${mid} AND status <> 'resolue'
        AND opened_at > ${m.at}::timestamptz - interval '24 hours'
        AND (lower(issue) = lower(${p.title}) OR opened_at > ${m.at}::timestamptz - interval '30 minutes') LIMIT 1`;
      if (dup.length) { done.push(`${rf(n)} : panne déjà ouverte`); continue; }
      await sql`INSERT INTO failures (id, machine_id, issue, notes, severity, status, reported_by, stopped_at, opened_at)
        VALUES (${newId()}, ${mid}, ${p.title}, ${`WhatsApp (${m.group}) : ${text}`.slice(0, 2000)}, 'moyenne', 'ouverte', ${m.sender}, ${m.at}, ${m.at})`;
      done.push(`${rf(n)} : panne ouverte « ${p.title} »`);
    } else if (p.kind === "change") {
      const title = workTitle(p, n).slice(0, 300);
      if (title.startsWith("Count change") && await openCountWork(n, m.at)) { done.push(`${rf(n)} : count change déjà noté`); continue; }
      const dup = await sql`SELECT id FROM works WHERE machine_no = ${n} AND status = 'todo' AND title = ${title}
        AND created_at > ${m.at}::timestamptz - interval '24 hours' LIMIT 1`;
      if (dup.length) { done.push(`${rf(n)} : travail déjà noté`); continue; }
      await sql`INSERT INTO works (id, machine_no, title, status, auto, author_name, created_at)
        VALUES (${newId()}, ${n}, ${title}, 'todo', true, ${`WhatsApp · ${m.sender}`.slice(0, 120)}, ${m.at})`;
      done.push(`${rf(n)} : travail à effectuer « ${title} »`);
    } else if (p.kind === "maint") {
      // Comme le bouton « Maintenance faite » de l'app : visite périodique aujourd'hui, prochaine dans 30 jours.
      const day = new Date(m.at.getTime() + 3600_000).toISOString().slice(0, 10); // date au Bénin
      const dup = await sql`SELECT id FROM maintenance_records WHERE machine_id = ${mid} AND performed_at = ${day}::date LIMIT 1`;
      if (dup.length) { done.push(`${rf(n)} : maintenance déjà enregistrée aujourd'hui`); continue; }
      await sql`INSERT INTO maintenance_records (id, machine_id, maintenance_type, performed_at, next_due, technician, notes)
        VALUES (${newId()}, ${mid}, 'Visite périodique', ${day}::date, ${day}::date + 30, ${m.sender}, ${`WhatsApp (${m.group}) : ${text}`.slice(0, 2000)})`;
      // La maintenance programmée par le superviseur pour cette machine est faite : on l'efface.
      await sql`UPDATE machines SET last_maintenance = ${day}::date, next_maintenance = ${day}::date + 30,
        maint_planned_by = NULL, maint_planned_at = NULL, maint_plan_note = NULL WHERE id = ${mid}`;
      done.push(`${rf(n)} : maintenance faite le ${ddmm(day)}, prochaine le ${ddmm(addDays(day, 30))}`);
      confirm.push(`${rf(n)} — prochaine le ${ddmm(addDays(day, 30))}`);
    } else if (p.kind === "close") {
      const f = await sql`UPDATE failures SET status = 'resolue', resolved_at = ${m.at}, restarted_at = ${m.at},
        technician = ${m.sender}, fixed_by = ${m.sender} WHERE machine_id = ${mid} AND status <> 'resolue' RETURNING id, issue`;
      // Mémoire des solutions : ce qui a été fait (« started, air filter changed »), réutilisé par l'assistant.
      const how = solution ?? solutionText(text);
      if (how) for (const x of f) await sql`INSERT INTO wa_solutions (failure_id, machine_no, issue, solution, author) VALUES (${x.id}, ${n}, ${x.issue}, ${how}, ${m.sender})`;
      // Les changements de pignons en attente ne se valident QUE par le bouton « Fait » de l'app.
      const w = await sql`UPDATE works SET status = 'done', done_by_name = ${m.sender}
        WHERE machine_no = ${n} AND status = 'todo' AND author_name LIKE 'WhatsApp%'
          AND id NOT IN (SELECT work_id FROM gear_change_requests WHERE status = 'pending' AND work_id IS NOT NULL) RETURNING id`;
      done.push(`${rf(n)} : ${f.length} panne(s) et ${w.length} travail(aux) clôturé(s)`);
    }
  }

  const action = machines.length ? p.kind : "ignore";
  // Message non compris par les règles mais qui parle d'un métier : l'IA le relit et le réécrit simplement.
  if (action === "ignore" && smart) {
    const again = await smartRead(text, quoted).catch((e) => { console.error("Relecture IA:", e); return null; });
    if (again) {
      const r = await handleText(m, again, null, solution, false);
      if (r.action !== "ignore") {
        await sql`UPDATE wa_messages SET result = result || ${sql.json({ ai: again })} WHERE msg_id = ${m.msgId}`;
        return { ...r, ai: again };
      }
    }
  }
  // Confirmation dans le groupe pour la maintenance clg enregistrée par message.
  const reply = confirm.length ? `✅ *Maintenance clg enregistrée* par ${m.sender}\n${confirm.map((c) => `• ${c}`).join("\n")}` : null;
  await sql`UPDATE wa_messages SET action = ${action}, machines = ${machines}, result = ${sql.json({ title: p.title, fromQuote: p.fromQuote, done, reply })}
    WHERE msg_id = ${m.msgId}`;
  if (done.length) await broadcastChanged();
  return { action, machines, title: p.title, done, reply };
}

// Numéro de l'expéditeur noté avec le message ; nom WhatsApp repris pour les personnes de la liste encore sans nom.
async function notePhone(msgId: string, phone: unknown, sender: string) {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (d.length < 8) return;
  await sql`UPDATE wa_messages SET phone = ${d} WHERE msg_id = ${msgId}`.catch(() => {});
  await learnName(await personByPhone(d), sender).catch(() => {});
}

type HandleResult = { action: string; machines: number[]; title: string; done: string[]; reply: string | null; ai?: string };

// ---------- Relecture par l'IA (01/11/2026) ----------
const OTHER_DEPT = /\b(l\s*\/\s*c|lc|o\.?\s*e|simplex|carding|cards?|blow\s*room|drums?|auto\s*coner|autoconer|uniclean|luwa|draw\s*frame|comber|lap\s*former|winding|compressor|compresseur)\b/i;
const RF_HINT = /\b(ring\s*fra?me?s?|r\s*\/\s*f|rf|rif|m\s*\/\s*c|mc|machines?|m[ée]tiers?|continus?)\b/i;
const SMART_PROMPT = `You read one WhatsApp message from the RING FRAME department of a spinning mill (28 ring frames numbered 1 to 28).
Decide if it reports something to record for a ring frame:
- "fault": a breakdown / problem / request for maintenance, electricians or a technician on a ring frame;
- "close": the ring frame is running again / problem solved;
- "maint": periodic maintenance (clg / cleaning) is finished;
- "change": count change, lot change or gear change to do;
- "none": anything else (other departments like LC, OE, simplex, carding, blow room; staff lists; greetings; reports; questions).
machines = ring frame numbers concerned (1-28) — only if clearly ring frames. summary = 2 to 8 words in English describing the problem or the change
(e.g. "Electricians needed", "Sensors adjustment", "Belt broken", "Count change").
Answer ONLY with JSON: {"kind": "fault"|"close"|"maint"|"change"|"none", "machines": [int], "summary": string}`;

async function smartRead(text: string, quoted: string | null): Promise<string | null> {
  const t = text.replace(/^\[photo\]\s*/, "").trim();
  if (t.length < 6 || t.length > 600 || OTHER_DEPT.test(t)) return null;
  if (!RF_HINT.test(t) && !(quoted && RF_HINT.test(quoted))) return null;
  if (!/(?<!\d)([1-9]|1\d|2[0-8])(?!\d)/.test(`${t} ${quoted ?? ""}`)) return null;
  // Limite par jour : le quota gratuit de l'IA est partagé avec la lecture des fiches et l'assistant.
  const limit = Number(await config("wa.ai_group_daily")) || 60;
  const day = beninDay();
  const [c] = await sql`SELECT count(*)::int AS n FROM notification_log WHERE key LIKE ${`wa-ai:${day}:%`}`;
  if (c.n >= limit) return null;
  await sql`INSERT INTO notification_log (key) VALUES (${`wa-ai:${day}:${crypto.randomUUID()}`})`;
  const raw = await gemini([{ role: "user", parts: [{ text: `${SMART_PROMPT}\n\nMessage: «${t}»${quoted ? `\nIt replies to: «${quoted.slice(0, 500)}»` : ""}` }] }],
    { schema: { type: "OBJECT", properties: { kind: { type: "STRING", enum: ["fault", "close", "maint", "change", "none"] }, machines: { type: "ARRAY", items: { type: "INTEGER" } }, summary: { type: "STRING" } }, required: ["kind", "machines"] },
      budgetMs: 45_000, perModelMs: 20_000, prefer: ["gemini-flash-lite-latest"] });
  const r = JSON.parse(raw) as { kind: string; machines: number[]; summary?: string };
  const nums = [...new Set((r.machines ?? []).map(Number).filter((n) => n >= 1 && n <= 28))];
  if (r.kind === "none" || !nums.length) return null;
  const mc = `Mc ${nums.join(" & ")}`;
  const what = String(r.summary ?? "").replace(/[^\p{L}\p{N} ,'\-/]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (r.kind === "close") return `${mc} running`;
  if (r.kind === "maint") return `Rf ${nums.join(" & ")} maintenance clg finish`;
  if (r.kind === "change") return `${mc} ${/count|lot|gear/i.test(what) ? what : "count change"}`;
  return `${mc} ${what || "problem, maintenance needed"}`;
}

async function ingest(body: Msg & { solution?: string | null; phone?: string | null }) {
  const text = String(body.text ?? "").slice(0, 4000);
  const m = meta(body);
  if (!m.msgId || !text.trim()) return { status: 400, data: { error: "msgId et text obligatoires" } };
  const quoted = body.quoted ? String(body.quoted).slice(0, 2000) : null;
  if (!(await firstTime(m, text, quoted))) return { status: 200, data: { duplicate: true } };
  await notePhone(m.msgId, body.phone, m.sender);
  return { status: 200, data: await handleText(m, text, quoted, body.solution ?? null) };
}

// ---------- Fiche « Count change slip » en photo ----------

type Gv = number | "same" | null; // « same » = on garde le pignon actuel de la machine
type Slip = { isSlip: boolean; machines: number[]; count: string | null; hank: number | null; draft: number | null; g: Gv; h: Gv };

const SLIP_PROMPT = `You read photos from a spinning mill (ring frames). Decide if the photo is a "COUNT CHANGE SLIP" form.
If it is, read the handwritten values. Rules:
- If a value is crossed out and another value is written next to it, return ONLY the new value (not crossed out).
- A small "T" after a number means "teeth": ignore the T.
- "Machine NO" can list several machines ("22 and 26", "3&4", "5,6") → return all numbers.
- count: the text exactly as written (e.g. "60 CCW", "12 KW PRO", "80 CCLX").
- hank: the R. HANK number. draft: the DRAFT number. g: the G number. h: the H number.
- If G or H is written as "same" (or "idem", "same as before", "-", "do"), return the string "same" for it.
Answer ONLY with JSON: {"isSlip": boolean, "machines": [int], "count": string|null, "hank": number|null, "draft": number|null, "g": int|"same"|null, "h": int|"same"|null}`;

async function readSlip(b64: string, mime: string): Promise<Slip> {
  let txt: string;
  try {
    txt = await gemini([{ role: "user", parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: SLIP_PROMPT }] }]);
  } catch (e) {
    if (e instanceof QuotaError) throw e;
    throw new Error(`lecture de la photo impossible (${e instanceof Error ? e.message : e})`);
  }
  const raw = JSON.parse(txt);
  const int = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const gv = (v: unknown): Gv => (typeof v === "string" && /same|idem|inchang|^\s*(-|do)\s*$/i.test(v) ? "same" : int(v));
  const num = (v: unknown) => (v != null && Number.isFinite(Number(String(v).replace(",", "."))) ? Number(String(v).replace(",", ".")) : null);
  return {
    isSlip: !!raw.isSlip,
    machines: (Array.isArray(raw.machines) ? raw.machines : []).map(int).filter((n: number | null): n is number => !!n && n >= 1 && n <= 28),
    count: raw.count ? String(raw.count).replace(/\s+/g, " ").trim().toUpperCase().slice(0, 40) : null,
    hank: num(raw.hank), draft: num(raw.draft), g: gv(raw.g), h: gv(raw.h),
  };
}


async function slip(body: Msg & { image?: string; mime?: string; caption?: string; dry?: boolean; fakeSlip?: Slip }) {
  const m = meta(body);
  const caption = String(body.caption ?? "").slice(0, 2000);
  // Photo envoyée avec la légende « !test » : on lit et on vérifie le stock, sans rien enregistrer.
  const dry = !!body.dry || /^!test\b/i.test(caption.trim());
  if (!m.msgId || (!body.image && !(dry && body.fakeSlip))) return { status: 400, data: { error: "msgId et image obligatoires" } };
  if (!dry && !(await firstTime(m, caption ? `[photo] ${caption}` : "[photo]", null))) return { status: 200, data: { duplicate: true } };
  // Photo avec une légende qui n'est pas un count change (panne, magasin, graissage…) : on traite la légende tout de suite,
  // sans lecture de la photo (une photo d'écran de panne n'est pas une fiche).
  // Légende « count change finish / attend / done » : la fiche est appliquée tout de suite ;
  // « count change » seul ou « à faire » : en attente du bouton Fait ; pas de légende : le robot pose la question.
  const ccState = caption.trim() ? countChangeState(caption) : null;
  if (!dry && caption.trim() && !ccState) {
    const p = parseMessage(caption, null);
    if (!(p.kind === "change" && /count/i.test(p.title))) return { status: 200, data: await handleText(m, caption, null) };
  }
  const applyNow = ccState === "done";
  const askAfter = !caption.trim();

  let s: Slip;
  // fakeSlip : test du calcul sans photo (mode test uniquement).
  try { s = dry && body.fakeSlip ? body.fakeSlip : await readSlip(body.image!, body.mime || "image/jpeg"); }
  catch (e) {
    console.error("Fiche:", e);
    const quota = e instanceof QuotaError;
    const warn = quota ? `${quotaMessage()}\nRenvoyez la photo de la fiche après cette heure.` : null;
    if (dry) return { status: 200, data: { action: "error", reply: quota ? warn : `🧪 Test : ${e instanceof Error ? e.message : e}` } };
    await sql`UPDATE wa_messages SET action = 'error', result = ${sql.json({ error: String(e) })} WHERE msg_id = ${m.msgId}`;
    const r = caption ? await handleText(m, caption, null) : { action: "error", error: String(e) };
    return { status: 200, data: { ...r, reply: warn ?? (r as { reply?: string }).reply ?? null } };
  }
  if (dry && (!s.isSlip || !s.machines.length)) return { status: 200, data: { action: "ignore", reply: "🧪 Test : ce n'est pas une fiche Count change (ou numéro de machine illisible)." } };
  // Pas une fiche de count change : on traite seulement la légende comme un message normal.
  if (!s.isSlip || !s.machines.length) {
    if (caption) return { status: 200, data: await handleText(m, caption, null) };
    await sql`UPDATE wa_messages SET action = 'ignore', result = ${sql.json({ slip: s })} WHERE msg_id = ${m.msgId}`;
    return { status: 200, data: { action: "ignore" } };
  }

  const machineRows = await sql`SELECT machine_no, run_g, run_h FROM machines WHERE machine_no = ANY(${s.machines}) ORDER BY machine_no`;
  const inRange = (t: "G" | "H", v: number | null) => v != null && v >= RANGE[t][0] && v <= RANGE[t][1];
  // Pignons voulus par machine : « same » = celui déjà monté sur la machine.
  const plan = machineRows.map((r) => {
    const cur = { g: r.run_g as number | null, h: r.run_h as number | null };
    const ng = s.g === "same" ? cur.g : s.g;
    const nh = s.h === "same" ? cur.h : s.h;
    return { no: Number(r.machine_no), g: cur.g, h: cur.h, ng, nh, changeG: ng !== cur.g, changeH: nh !== cur.h };
  });
  const label = `Mc ${plan.map((x) => x.no).join(" et ")}`;
  const ref = plan[0];
  const calc = ref && ref.ng && ref.nh ? draftOf(ref.ng, ref.nh) : null;
  const target = s.draft ?? calc ?? (s.count && s.hank ? parseFloat(s.count) / s.hank : null);
  const stock = await availableStock(plan.map((x) => x.no));
  // Pièces nécessaires par pignon (6 par machine qui change), comparées au stock disponible.
  const need = new Map<string, number>();
  for (const x of plan) {
    if (x.changeG) need.set(`G${x.ng}`, (need.get(`G${x.ng}`) ?? 0) + PER_MACHINE);
    if (x.changeH) need.set(`H${x.nh}`, (need.get(`H${x.nh}`) ?? 0) + PER_MACHINE);
  }
  const unreadable = plan.some((x) => (x.changeG && !inRange("G", x.ng)) || (x.changeH && !inRange("H", x.nh)));
  const missing = [...need.entries()].filter(([k, n]) => (stock.get(k) ?? 0) < n);
  const available = !unreadable && missing.length === 0;
  const explicit = s.g !== "same" || s.h !== "same";
  const already = plan.filter((x) => !x.changeG && !x.changeH);
  const done: string[] = [];
  const notes: string[] = [];
  const created: string[] = [];
  const readable = (x: { changeG: boolean; changeH: boolean; ng: number | null; nh: number | null }) =>
    (!x.changeG || inRange("G", x.ng)) && (!x.changeH || inRange("H", x.nh));

  for (const x of dry ? [] : plan) {
    const base = `Count change Mc ${x.no}${s.count ? ` (${s.count})` : ""}`;
    const what = !x.changeG && !x.changeH ? "pignons inchangés"
      : available ? [x.changeG ? `G${x.ng}` : "G inchangé", x.changeH ? `H${x.nh}` : "H inchangé"].join(" / ")
      : "pignons à choisir";
    const title = `${base} · ${what}`.slice(0, 300);
    // Une seule ligne par machine sur l'accueil : on reprend le travail déjà noté par message, sinon on le crée.
    const old = await openCountWork(x.no, m.at);
    let workId: string;
    if (old) { workId = old.id; await sql`UPDATE works SET title = ${title} WHERE id = ${workId}`; }
    else {
      workId = newId();
      await sql`INSERT INTO works (id, machine_no, title, status, auto, author_name, created_at)
        VALUES (${workId}, ${x.no}, ${title}, 'todo', true, ${`WhatsApp · ${m.sender}`.slice(0, 120)}, ${m.at})`;
    }
    await sql`UPDATE gear_change_requests SET status = 'cancelled' WHERE machine_no = ${x.no} AND status = 'pending'`;
    // Bouton « Fait » : change les pignons (ou seulement le count si rien ne change).
    // Déjà changé (légende « finish ») : on applique même si le stock affiché est trop bas, dès que G/H sont lisibles.
    if ((available || (!x.changeG && !x.changeH) || (applyNow && readable(x))) && x.ng != null && x.nh != null) {
      const [req] = await sql`INSERT INTO gear_change_requests (machine_no, new_g, new_h, count_label, draft, work_id, source)
        VALUES (${x.no}, ${x.ng}, ${x.nh}, ${s.count}, ${target}, ${workId}, ${m.msgId}) RETURNING id`;
      created.push(String(req.id));
      done.push(`${rf(x.no)} : « ${title} » en attente du bouton Fait`);
    } else done.push(`${rf(x.no)} : pignons indisponibles, propositions envoyées`);
  }

  // Les dents demandées sont déjà celles de la machine : on prévient le groupe.
  if (explicit && already.length) {
    for (const x of already) notes.push(`ℹ️ *Count change ${rf(x.no)}* : G${x.g ?? "?"} · H${x.h ?? "?"} sont déjà montés sur la machine — aucun pignon à changer.`);
  }
  // Draft de la fiche qui ne colle pas avec G/H : probable erreur d'écriture ou de lecture.
  if (s.draft && calc && Math.abs(calc - s.draft) / s.draft > 0.015) {
    notes.push(`⚠️ *Count change ${label}* : draft fiche ${fmt2(s.draft)} mais G${ref.ng} · H${ref.nh} donnent ${fmt2(calc)} — vérifier la fiche.`);
  }
  // Changement déjà fait : on l'applique (pignons, count, stock ; la confirmation part du déclencheur).
  if (!dry && applyNow && created.length) {
    const applied = await applyPending(created, m.sender, m.at);
    done.push(...applied);
  }
  if (!dry && applyNow && plan.some((x) => !readable(x))) {
    notes.push(`⚠️ *Count change ${label}* : G ou H illisible sur la photo. Renvoyez une photo plus nette avec la légende *count change finish*, ou corrigez G/H dans la fiche du métier (app).`);
  }
  // Photo sans légende : on demande si le changement est déjà fait.
  if (!dry && askAfter && created.length) {
    await markAsked(created, m.group, m.sender);
    const what = plan.map((x) => `${rf(x.no)} : G${x.ng ?? "?"} · H${x.nh ?? "?"}`).join("\n");
    notes.unshift(`❓ *Count change ${label}*${s.count ? ` — ${s.count}` : ""}\n${what}\n\nLe changement est-il *déjà fait* ?\nRépondez *1* : déjà changé ✅\nRépondez *2* : à changer plus tard ⏳`);
  }
  if (!available && plan.length && !applyNow) {
    const lines = [`⚠️ *Count change ${label}*${s.count ? ` — ${s.count}` : ""}${target ? ` · draft ${fmt2(target)}` : ""}`];
    lines.push(`Fiche : G${s.g ?? "?"} · H${s.h ?? "?"}`);
    if (unreadable) lines.push(`❌ G ou H illisible ou hors plage (G ${RANGE.G[0]}–${RANGE.G[1]}, H ${RANGE.H[0]}–${RANGE.H[1]})`);
    for (const [k, n] of missing) lines.push(`❌ ${k} : ${Math.max(0, stock.get(k) ?? 0)} en stock (il en faut ${n})`);
    if (target) {
      const p = proposals(target, { g: ref?.ng ?? null, h: ref?.nh ?? null }, stock, plan.length);
      if (p.list.length) {
        lines.push(p.close ? "💡 *Propositions en stock :*" : "💡 *Rien à moins de 1 % ; les plus proches en stock :*");
        p.list.forEach((x, i) => lines.push(`${i + 1}) G${x.g} · H${x.h} → draft ${fmt2(x.d)} (${pct(x.err)})`));
      } else lines.push("Aucun couple G/H en stock suffisant.");
    } else lines.push("Draft illisible : impossible de proposer d'autres pignons.");
    notes.push(lines.join("\n"));
  }
  const reply = notes.length ? notes.join("\n\n") : null;

  if (dry) {
    const head = `🧪 *Test lecture* — ${label} · ${s.count ?? "count ?"} · draft ${s.draft ?? "?"} · G ${s.g ?? "?"} · H ${s.h ?? "?"}`;
    const now = plan.map((x) => `${rf(x.no)} : actuel G${x.g ?? "?"} · H${x.h ?? "?"} → G${x.ng ?? "?"} · H${x.nh ?? "?"}`).join("\n");
    const end = available ? "✅ Pignons disponibles : en vrai, un bouton « Fait » serait créé sur l'accueil." : "";
    return { status: 200, data: { action: "dry", slip: s, available, reply: [head, now, end, reply].filter(Boolean).join("\n") } };
  }

  await sql`UPDATE wa_messages SET action = 'slip', machines = ${plan.map((x) => x.no)},
    result = ${sql.json({ slip: s, available, done, reply })} WHERE msg_id = ${m.msgId}`;
  if (done.length) await broadcastChanged();
  return { status: 200, data: { action: "slip", slip: s, available, done, reply } };
}

// ---------- Note vocale dans un groupe : transcrite puis traitée comme un message écrit ----------
async function voice(body: Msg & { audio?: string; mime?: string }) {
  const m = meta(body);
  if (!m.msgId || !body.audio) return { status: 400, data: { error: "msgId et audio obligatoires" } };
  const quoted = body.quoted ? String(body.quoted).slice(0, 2000) : null;
  if (!(await firstTime(m, "[vocal]", quoted))) return { status: 200, data: { duplicate: true } };
  let text = "";
  try { text = await transcribe(body.audio, body.mime || "audio/ogg"); }
  catch (e) {
    console.error("Vocal:", e);
    await sql`UPDATE wa_messages SET action = 'error', result = ${sql.json({ error: String(e) })} WHERE msg_id = ${m.msgId}`;
    return { status: 200, data: { action: "error", error: String(e) } };
  }
  await sql`UPDATE wa_messages SET body = ${`[vocal] ${text}`.slice(0, 4000)} WHERE msg_id = ${m.msgId}`;
  if (!text) return { status: 200, data: { action: "ignore", heard: "" } };
  return { status: 200, data: { ...(await handleText(m, text, quoted)), heard: text } };
}

// ---------- Rapport PDF de quart (groupe Spinning Shift Supervisors) ----------
async function reportPdf(body: Msg & { pdf?: string; fileName?: string; dry?: boolean; phone?: string | null }) {
  const m = meta(body);
  if (!m.msgId || !body.pdf) return { status: 400, data: { error: "msgId et pdf obligatoires" } };
  const name = String(body.fileName ?? "rapport.pdf").slice(0, 200);
  if (!body.dry && !(await firstTime(m, `[pdf] ${name}`, null))) return { status: 200, data: { duplicate: true } };
  if (!body.dry) await notePhone(m.msgId, body.phone, m.sender);
  const r = await handleReportPdf(body, m);
  if (!body.dry) await sql`UPDATE wa_messages SET action = ${r.ok ? ("ignored" in r ? "ignore" : "report") : "error"},
    result = ${sql.json({ ...r, rows: undefined } as Record<string, unknown>)} WHERE msg_id = ${m.msgId}`;
  return { status: 200, data: r };
}

// Action confirmée « Oui » dans l'assistant : enregistrée comme un message du groupe.
const execFromChat = async (text: string, sender: string, id: string, solution: string | null) =>
  (await ingest({ msgId: id, group: "Assistant (privé)", sender, text, solution })).data as { done?: string[]; reply?: string | null };

// ---------- Manuel : chargement par morceaux (script charger-manuel.js sur le VPS) ----------
type Chunk = { key: string; page?: number; title?: string; content: string };
async function loadKnowledge(body: { source?: string; chunks?: Chunk[] }) {
  const source = String(body.source ?? "Manuel").slice(0, 120);
  let n = 0;
  for (const c of (body.chunks ?? []).slice(0, 200)) {
    const content = String(c.content ?? "").slice(0, 6000);
    if (!c.key || content.trim().length < 20) continue;
    await sql`INSERT INTO wa_knowledge (source, title, content, chunk_key, page)
      VALUES (${source}, ${c.title ? String(c.title).slice(0, 200) : null}, ${content}, ${String(c.key).slice(0, 120)}, ${Number.isFinite(Number(c.page)) ? Number(c.page) : null})
      ON CONFLICT (chunk_key) DO UPDATE SET source = EXCLUDED.source, title = EXCLUDED.title, content = EXCLUDED.content, page = EXCLUDED.page`;
    n++;
  }
  const [t] = await sql`SELECT count(*)::int AS n FROM wa_knowledge WHERE source = ${source}`;
  return { saved: n, total: t.n };
}

// ---------- Rapport du matin ----------
const GREASE_POINTS = [
  { k: "nipples", n: "Nipples", d: 30 }, { k: "front", n: "Front rollers", d: 15 }, { k: "blackmiddle", n: "Black & middle rollers", d: 30 },
  { k: "mainshaft", n: "Main shaft", d: 365 }, { k: "screwrod", n: "Screw rod", d: 30 }, { k: "gearing", n: "All gearing", d: 30 },
];
const LUB_BOXES = [
  { k: "drafting", n: "Drafting gear box", d: 30 }, { k: "ringrail", n: "Ring rail gear box", d: 30 }, { k: "doffer", n: "Doffer gear box", d: 30 }, { k: "servodisc", n: "Servodisc gear box", d: 30 },
];
const CYCLE_OVERRIDES = [{ kind: "grease", point: "front", from: 21, to: 28, d: 7 }];
const DAYS_FR = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];

function staticDays(kind: string, point: string, no: number): number {
  const o = CYCLE_OVERRIDES.find((x) => x.kind === kind && x.point === point && no >= x.from && no <= x.to);
  if (o) return o.d;
  return (kind === "grease" ? GREASE_POINTS : LUB_BOXES).find((p) => p.k === point)?.d ?? 30;
}

type Item = { no: number; due: string; days: number; detail?: string };

// Règle du rapport : 3 machines par rubrique. Les machines en retard d'abord (les plus en retard),
// complétées par les prochaines échéances : 3 en retard → les 3 ; 2 → 2 + 1 ; 1 → 1 + 2 ; 0 → les 3 prochaines.
function section(title: string, items: Item[]): string[] {
  const sorted = [...items].sort((a, b) => a.days - b.days || a.no - b.no);
  const late = sorted.filter((i) => i.days < 0);
  const coming = sorted.filter((i) => i.days >= 0);
  const shown = late.length >= 3 ? late.slice(0, 3) : [...late, ...coming.slice(0, 3 - late.length)];
  const lines = [`*${title}*`];
  if (!shown.length) lines.push("✅ Rien à signaler");
  for (const i of shown) lines.push(`• Mc ${i.no} — ${i.detail ?? `${ddmm(i.due)} (${when(i.days)})`}`);
  const extra = late.slice(3);
  if (extra.length) lines.push(`_+ ${extra.length} autre(s) en retard : ${extra.map((i) => `Mc ${i.no}`).join(", ")}_`);
  return lines;
}

function byMachine(points: Array<{ no: number; name: string; due: string; days: number }>): Item[] {
  const map = new Map<number, Array<{ name: string; due: string; days: number }>>();
  for (const p of points) (map.get(p.no) ?? map.set(p.no, []).get(p.no)!).push(p);
  return [...map.entries()].map(([no, list]) => {
    list.sort((a, b) => a.days - b.days);
    const first = list[0];
    const shown = list.filter((p) => p.days <= Math.max(2, first.days));
    return { no, due: first.due, days: first.days, detail: shown.map((p) => `${p.name} ${ddmm(p.due)} (${when(p.days)})`).join(", ") };
  });
}

async function report(): Promise<string> {
  const now = new Date(Date.now() + 3600_000); // heure du Bénin (UTC+1)
  const today = isoDay(now);
  const [machines, greasing, points, failures, works] = await Promise.all([
    sql`SELECT machine_no, next_maintenance FROM machines WHERE machine_no BETWEEN 1 AND 28`,
    sql`SELECT DISTINCT ON (kind, machine_no, point_key) kind, machine_no, point_key, done_on
        FROM greasing_records ORDER BY kind, machine_no, point_key, done_on DESC, created_at DESC`,
    sql`SELECT kind, point_key, name, interval_days FROM g37_cycle_points`,
    sql`SELECT machine_id, issue, opened_at FROM failures WHERE status <> 'resolue' ORDER BY opened_at`,
    sql`SELECT machine_no, title, created_at FROM works WHERE status = 'todo' ORDER BY created_at`,
  ]);

  // Maintenance déjà prévue aujourd'hui : machine ajoutée dans « Travaux à effectuer » depuis le dernier rapport
  // (titre « Maintenance », « Maintenance clg », « Maintenance générale », « cleaning »…).
  // Accepte aussi les fautes courantes : « Maint clg », « Maintenace », « Cleanning », « Clening », « Entretien »…
  const isMaintWork = (t: string) => /\b(maint\w*|mtce|mntc|clg|clng|clea?n\w*|nettoy\w*|entretien)\b/i.test(t) && !/\bteam\b/i.test(t);
  const todayWorks = works.filter((w) => isMaintWork(String(w.title)) && Date.now() - new Date(w.created_at).getTime() < 24 * 3600_000);
  const todayMaint = [...new Set(todayWorks.map((w) => Number(w.machine_no)))].sort((a, b) => a - b);

  const maint: Item[] = machines.filter((m) => m.next_maintenance && !todayMaint.includes(Number(m.machine_no))).map((m) => {
    const due = isoDay(m.next_maintenance);
    return { no: Number(m.machine_no), due, days: diff(due, today) };
  });

  const custom = new Map(points.map((c) => [`${c.kind}:${c.point_key}`, c]));
  const grease: Array<{ no: number; name: string; due: string; days: number }> = [];
  const sched: typeof grease = [];
  for (const r of greasing) {
    const no = Number(r.machine_no);
    const c = custom.get(`${r.kind}:${r.point_key}`);
    if (r.kind === "sched" && !c) continue;
    const every = c ? Number(c.interval_days) : staticDays(r.kind, r.point_key, no);
    const due = addDays(isoDay(r.done_on), every);
    const name = c?.name ?? (r.kind === "grease" ? GREASE_POINTS : LUB_BOXES).find((p) => p.k === r.point_key)?.n ?? r.point_key;
    (r.kind === "sched" ? sched : grease).push({ no, name, due, days: diff(due, today) });
  }

  const todo: Array<{ no: number; line: string }> = [];
  for (const f of failures) {
    const no = Number(String(f.machine_id).replace(/\D/g, "")) || 0;
    const age = diff(today, isoDay(new Date(new Date(f.opened_at).getTime() + 3600_000)));
    todo.push({ no, line: `${rf(no)} — ${f.issue} (panne${age > 0 ? `, depuis ${age} j` : ", signalée aujourd'hui"})` });
  }
  for (const w of works.filter((x) => !todayWorks.includes(x))) todo.push({ no: Number(w.machine_no), line: w.title.startsWith("Count change") ? w.title : `${rf(Number(w.machine_no))} — ${w.title}` });
  todo.sort((a, b) => a.no - b.no);

  const d = new Date(today + "T00:00:00Z");
  const out: string[] = [`*🔧 Atelier G37 — ${DAYS_FR[d.getUTCDay()]} ${today.slice(8, 10)}/${today.slice(5, 7)}*`, ""];
  if (todayMaint.length) out.push(`*🧹 Today Maintenance clg : ${todayMaint.map(rf).join(", ")}*`, "");
  out.push(...section("⏰ Maintenance clg", maint), "");
  out.push(...section("🛢️ Graissage", byMachine(grease)), "");
  out.push(...section("📅 Schedule works", byMachine(sched)), "");
  out.push("*🛠️ Travaux à effectuer*");
  out.push(...(todo.length ? todo.map((t) => `• ${t.line}`) : ["✅ Aucun travail en attente"]));
  return out.join("\n");
}

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/^.*?\/wa-bot\/?/, "").replace(/\/+$/, "");
  try {
    if (!(await authorized(req))) return json({ error: "forbidden" }, 403);
    if (req.method === "POST" && path === "ingest") { const r = await ingest(await req.json()); return json(r.data, r.status); }
    if (req.method === "POST" && path === "slip") { const r = await slip(await req.json()); return json(r.data, r.status); }
    if (req.method === "POST" && path === "report-pdf") { const r = await reportPdf(await req.json()); return json(r.data, r.status); }
    if (req.method === "POST" && path === "voice") { const r = await voice(await req.json()); return json(r.data, r.status); }
    if (req.method === "POST" && path === "chat") return json(await chat(await req.json(), execFromChat));
    if (req.method === "POST" && path === "knowledge") return json(await loadKnowledge(await req.json()));
    if (req.method === "POST" && path === "knowledge-search") { const b = await req.json(); return json({ text: await knowledge(String(b.q ?? "")) }); }
    if (req.method === "GET" && path === "report") return json({ text: await report() });
    if (req.method === "GET" && path === "outbox") return json({ messages: await takeOutbox() });
    if (req.method === "POST" && path === "outbox-ack") { const b = await req.json(); return json(await ackOutbox((b.ids ?? []).map(Number).filter(Number.isFinite))); }
    if (req.method === "POST" && path === "command") { const b = await req.json(); return json({ reply: await command(String(b.text ?? "")) }); }
    if (req.method === "GET" && path === "tick") return json(await tick());
    if (req.method === "GET" && path === "watchdog") return json(await watchdog());
    if (req.method === "POST" && path === "dry") { const b = await req.json(); return json(parseMessage(String(b.text ?? ""), b.quoted ?? null)); }
    if (req.method === "POST" && path === "dry-slip") { const b = await req.json(); return json(await readSlip(b.image, b.mime || "image/jpeg")); }
    if (req.method === "GET" && path === "evening") return json(await eveningRun());
    // Essai sans rien envoyer : machines prévues aujourd'hui et personnes qui seraient appelées.
    if (req.method === "POST" && path === "evening-dry") return json({ machines: await plannedToday(), callees: (await people()).filter((p) => p.call_tier != null).sort((a, b) => Number(a.call_tier) - Number(b.call_tier)).map((p) => ({ name: p.name, tier: p.call_tier, app: !!p.user_id })) });
    if (req.method === "POST" && path === "smart-dry") { const b = await req.json(); return json({ text: await smartRead(String(b.text ?? ""), b.quoted ?? null) }); }
    if (req.method === "GET" && path === "health") return json({ ok: true, at: new Date().toISOString() });
    return json({ error: `Route inconnue : ${req.method} ${path}` }, 404);
  } catch (e) {
    console.error("wa-bot:", e);
    return json({ error: e instanceof Error ? e.message : "Erreur serveur" }, 500);
  }
});
