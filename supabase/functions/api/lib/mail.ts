// Envoi d'e-mails par la boîte noreply (SMTP chez LWS) — 27/10/2026.
// Supabase bloque les ports 25 et 587 : on passe par le port 465 (SSL direct).
// Réglages dans app_config : smtp.host, smtp.port, smtp.user, smtp.pass, smtp.from, smtp.name.
import { db } from "./db.ts";

export type SmtpConf = { host: string; port: number; user: string; pass: string; from: string; name: string };

export async function smtpConfig(): Promise<SmtpConf | null> {
  const rows = await db.selectFrom("appConfig").select(["key", "value"]).where("key", "like", "smtp.%").execute();
  const m: Record<string, string> = Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
  if (!m["smtp.pass"]) return null;
  const user = m["smtp.user"] || "noreply@africansbiz.com";
  return {
    host: m["smtp.host"] || "mail.africansbiz.com",
    port: Number(m["smtp.port"] || 465),
    user,
    pass: m["smtp.pass"],
    from: m["smtp.from"] || user,
    name: m["smtp.name"] || "Spinning R/F",
  };
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (s: string) => {
  const bytes = enc.encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const wrap76 = (s: string) => s.replace(/.{1,76}/g, (x) => x + "\r\n").trimEnd();
const encWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

export type Mail = { to: string; subject: string; text: string; html: string };

export async function sendMail(conf: SmtpConf, mail: Mail): Promise<void> {
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("SMTP : délai dépassé")), 25000); });
  try {
    await Promise.race([talk(conf, mail), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function talk(conf: SmtpConf, mail: Mail) {
  const conn = await Deno.connectTls({ hostname: conf.host, port: conf.port });
  let buf = "";
  const read = async (): Promise<string> => {
    while (true) {
      const lines = buf.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3}( |$)/.test(lines[i])) {
          const reply = lines.slice(0, i + 1).join("\n");
          buf = lines.slice(i + 1).join("\r\n");
          return reply;
        }
      }
      const chunk = new Uint8Array(4096);
      const n = await conn.read(chunk);
      if (n === null) throw new Error("SMTP : connexion fermée");
      buf += dec.decode(chunk.subarray(0, n));
    }
  };
  const write = async (s: string) => {
    const data = enc.encode(s);
    let off = 0;
    while (off < data.length) off += await conn.write(data.subarray(off));
  };
  const expect = async (codes: number[]) => {
    const reply = await read();
    const last = reply.split("\n").pop() ?? "";
    if (!codes.some((c) => last.startsWith(String(c)))) throw new Error(`SMTP : ${reply.slice(0, 200)}`);
    return reply;
  };
  const cmd = async (line: string, codes: number[]) => { await write(line + "\r\n"); return expect(codes); };

  try {
    await expect([220]);
    await cmd("EHLO atelier-g37", [250]);
    await cmd("AUTH LOGIN", [334]);
    await cmd(b64(conf.user), [334]);
    await cmd(b64(conf.pass), [235]);
    await cmd(`MAIL FROM:<${conf.from}>`, [250]);
    await cmd(`RCPT TO:<${mail.to}>`, [250, 251]);
    await cmd("DATA", [354]);
    const boundary = `g37-${crypto.randomUUID()}`;
    const domain = conf.from.split("@")[1] ?? "localhost";
    const msg = [
      `From: ${encWord(conf.name)} <${conf.from}>`,
      `To: <${mail.to}>`,
      `Subject: ${encWord(mail.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@${domain}>`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(b64(mail.text)),
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(b64(mail.html)),
      `--${boundary}--`,
      "",
    ].join("\r\n");
    await write(msg + "\r\n.\r\n");
    await expect([250]);
    await cmd("QUIT", [221]).catch(() => {});
  } finally {
    try { conn.close(); } catch { /* déjà fermée */ }
  }
}
