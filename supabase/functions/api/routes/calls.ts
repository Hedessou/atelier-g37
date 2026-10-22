// deno-lint-ignore-file no-explicit-any
// Salles d'appel (Internet) : appel à deux ou en groupe jusqu'à 25 personnes, on peut rejoindre un appel en cours.
//   POST g37/call_room  { action: create | join | leave | decline | invite, id, invite?, group?, title? }
//   GET  g37/call_rooms — appels en cours (groupes ouverts + ceux où je suis invité)
// L'audio passe directement entre téléphones (WebRTC) ; le serveur ne fait que la mise en relation.
import { z } from "zod";
import { sql } from "../lib/db.ts";
import { getServerUserSession } from "../lib/session.ts";
import { json } from "../lib/http.ts";
import { broadcastTo } from "../lib/supa.ts";
import { callTopic } from "../lib/p2pKeys.ts";
import { loadMe } from "./mutate.ts";
import { notifyUsers } from "../lib/notify.ts";

export const MAX_PARTICIPANTS = 25;
const RING_MS = 50_000;

async function me(request: Request) {
  const { user } = await getServerUserSession(request);
  const row = await loadMe(user.id);
  if (!row) throw new Error("Compte introuvable");
  return row;
}

type Member = { userId: number; name: string; status: "in" | "ringing" | "declined" | "left" | "missed"; joinedAt: string | null };

async function roomView(roomId: string) {
  const [room] = await sql`SELECT id, created_by, is_group, title, created_at, ended_at FROM call_rooms WHERE id = ${roomId}`;
  if (!room) return null;
  const rows = await sql`SELECT m.user_id, u.display_name, m.invited_at, m.joined_at, m.left_at, m.declined_at
    FROM call_room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ${roomId} ORDER BY m.invited_at`;
  const now = Date.now();
  const members: Member[] = rows.map((m: any) => ({
    userId: m.user_id,
    name: m.display_name,
    joinedAt: m.joined_at ? new Date(m.joined_at).toISOString() : null,
    status: m.joined_at && !m.left_at ? "in"
      : m.declined_at ? "declined"
        : m.left_at ? "left"
          : now - new Date(m.invited_at).getTime() < RING_MS ? "ringing" : "missed",
  }));
  return {
    id: room.id, createdBy: room.created_by, group: room.is_group, title: room.title ?? null,
    createdAt: new Date(room.created_at).toISOString(), endedAt: room.ended_at ? new Date(room.ended_at).toISOString() : null, members,
  };
}

async function tell(userIds: number[], from: { id: number; displayName: string }, data: Record<string, unknown>) {
  await Promise.all([...new Set(userIds)].filter((id) => id !== from.id).map(async (id) =>
    broadcastTo(await callTopic(id), "signal", { from: from.id, fromName: from.displayName, data })));
}

async function joinedIds(roomId: string): Promise<number[]> {
  const rows = await sql`SELECT user_id FROM call_room_members WHERE room_id = ${roomId} AND joined_at IS NOT NULL AND left_at IS NULL`;
  return rows.map((r: any) => r.user_id);
}

async function inviteUsers(roomId: string, from: { id: number; displayName: string }, ids: number[], group: boolean) {
  const valid = ids.length ? await sql`SELECT id FROM users WHERE id = ANY(${ids}::int[]) AND id <> ${from.id}` : [];
  const list = valid.map((r: any) => r.id as number);
  if (!list.length) return [];
  for (const id of list) {
    await sql`INSERT INTO call_room_members (room_id, user_id, invited_at) VALUES (${roomId}, ${id}, now())
      ON CONFLICT (room_id, user_id) DO UPDATE SET invited_at = now(), declined_at = NULL
      WHERE call_room_members.joined_at IS NULL OR call_room_members.left_at IS NOT NULL`;
  }
  await tell(list, from, { type: "invite", roomId, group, name: from.displayName });
  await notifyUsers({
    userIds: list, tag: `appel-${roomId}`, kind: "call",
    title: group ? "Appel de groupe" : `Appel de ${from.displayName}`,
    body: group ? `${from.displayName} t'invite à un appel de groupe` : "Appel Spinning R/F",
    data: { room: roomId, from: from.id, name: from.displayName, group: group ? 1 : 0, tab: "discussion" },
  });
  return list;
}

async function endIfEmpty(roomId: string, from: { id: number; displayName: string }) {
  const still = await joinedIds(roomId);
  if (still.length) return false;
  await sql`UPDATE call_rooms SET ended_at = now() WHERE id = ${roomId} AND ended_at IS NULL`;
  const ringing = await sql`SELECT user_id FROM call_room_members WHERE room_id = ${roomId} AND joined_at IS NULL AND declined_at IS NULL
    AND invited_at > now() - interval '60 seconds'`;
  const ids = ringing.map((r: any) => r.user_id as number);
  if (ids.length) {
    await tell(ids, from, { type: "ended", roomId });
    await notifyUsers({ userIds: ids, tag: `appel-${roomId}`, kind: "call_end", title: "Appel manqué", body: `Appel de ${from.displayName}`, data: { room: roomId } });
  }
  return true;
}

const bodySchema = z.object({
  action: z.enum(["create", "join", "leave", "decline", "invite"]),
  id: z.string().regex(/^[A-Za-z0-9_-]{8,60}$/),
  invite: z.array(z.number().int()).max(MAX_PARTICIPANTS).optional(),
  group: z.boolean().optional(),
  title: z.string().max(80).optional(),
});

export async function handleCallRoom(request: Request): Promise<Response> {
  let user;
  try { user = await me(request); } catch { return json({ error: "Authentification requise" }, 401); }
  if (user.pending) return json({ error: "Ton compte doit être validé par l'admin avant d'appeler." }, 403);
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Requête invalide" }, 400);
  const { action, id } = parsed.data;
  const invite = [...new Set(parsed.data.invite ?? [])].filter((x) => x !== user.id);

  if (action === "create") {
    if (!invite.length) return json({ error: "Choisis au moins un collègue." }, 400);
    if (invite.length + 1 > MAX_PARTICIPANTS) return json({ error: `${MAX_PARTICIPANTS} personnes au maximum.` }, 400);
    const group = parsed.data.group ?? invite.length > 1;
    const inserted = await sql`INSERT INTO call_rooms (id, created_by, is_group, title) VALUES (${id}, ${user.id}, ${group}, ${parsed.data.title ?? null})
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    if (!inserted.length) return json({ error: "Appel déjà créé" }, 409);
    await sql`INSERT INTO call_room_members (room_id, user_id, invited_at, joined_at) VALUES (${id}, ${user.id}, now(), now())`;
    await inviteUsers(id, user, invite, group);
    return json({ room: await roomView(id) });
  }

  const [room] = await sql`SELECT id, is_group, ended_at, created_at FROM call_rooms WHERE id = ${id}`;
  if (!room) return json({ error: "Appel introuvable" }, 404);
  const [membership] = await sql`SELECT joined_at, left_at FROM call_room_members WHERE room_id = ${id} AND user_id = ${user.id}`;

  if (action === "join") {
    if (room.ended_at) return json({ error: "Cet appel est terminé." }, 410);
    if (!room.is_group && !membership) return json({ error: "Tu n'es pas invité à cet appel." }, 403);
    const inCall = await joinedIds(id);
    if (!inCall.includes(user.id) && inCall.length >= MAX_PARTICIPANTS) return json({ error: `Appel complet (${MAX_PARTICIPANTS} personnes).` }, 409);
    await sql`INSERT INTO call_room_members (room_id, user_id, invited_at, joined_at) VALUES (${id}, ${user.id}, now(), now())
      ON CONFLICT (room_id, user_id) DO UPDATE SET joined_at = now(), left_at = NULL, declined_at = NULL`;
    await tell(inCall, user, { type: "joined", roomId: id, userId: user.id, name: user.displayName });
    return json({ room: await roomView(id) });
  }

  if (action === "leave") {
    await sql`UPDATE call_room_members SET left_at = now() WHERE room_id = ${id} AND user_id = ${user.id} AND joined_at IS NOT NULL AND left_at IS NULL`;
    await tell(await joinedIds(id), user, { type: "left", roomId: id, userId: user.id, name: user.displayName });
    await endIfEmpty(id, user);
    return json({ ok: true });
  }

  if (action === "decline") {
    await sql`UPDATE call_room_members SET declined_at = now() WHERE room_id = ${id} AND user_id = ${user.id} AND joined_at IS NULL`;
    await tell(await joinedIds(id), user, { type: "declined", roomId: id, userId: user.id, name: user.displayName });
    return json({ ok: true });
  }

  // invite : ajouter des collègues pendant l'appel
  if (room.ended_at) return json({ error: "Cet appel est terminé." }, 410);
  if (!membership?.joined_at || membership.left_at) return json({ error: "Rejoins l'appel pour inviter quelqu'un." }, 403);
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM call_room_members WHERE room_id = ${id} AND (declined_at IS NULL) AND (left_at IS NULL)`;
  if (n + invite.length > MAX_PARTICIPANTS) return json({ error: `${MAX_PARTICIPANTS} personnes au maximum.` }, 400);
  await sql`UPDATE call_rooms SET is_group = true WHERE id = ${id}`;
  await inviteUsers(id, user, invite, true);
  return json({ room: await roomView(id) });
}

export async function handleCallRooms(request: Request): Promise<Response> {
  let user;
  try { user = await me(request); } catch { return json({ error: "Authentification requise" }, 401); }
  // Ménage : appels où plus personne n'est présent.
  await sql`UPDATE call_rooms r SET ended_at = now() WHERE r.ended_at IS NULL AND (r.created_at < now() - interval '6 hours' OR (r.created_at < now() - interval '2 minutes'
    AND NOT EXISTS (SELECT 1 FROM call_room_members m WHERE m.room_id = r.id AND m.joined_at IS NOT NULL AND m.left_at IS NULL)))`;
  const rows = await sql`SELECT r.id FROM call_rooms r WHERE r.ended_at IS NULL AND (r.is_group
    OR EXISTS (SELECT 1 FROM call_room_members m WHERE m.room_id = r.id AND m.user_id = ${user.id})) ORDER BY r.created_at DESC LIMIT 20`;
  const rooms = (await Promise.all(rows.map((r: any) => roomView(r.id)))).filter(Boolean);
  return json({ rooms, max: MAX_PARTICIPANTS });
}
