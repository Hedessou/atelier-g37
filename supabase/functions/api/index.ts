// Serveur de l'app Atelier G37 (Supabase Edge Function « api »).
import { CORS, json, withCors } from "./lib/http.ts";
import { handleChangePassword, handleForgotPassword, handleLogin, handleLogout, handleRegister, handleResetPassword, handleSession } from "./routes/auth.ts";
import { handleState } from "./routes/state.ts";
import { handleMutate, handleSync } from "./routes/mutate.ts";
import { handleCalc, handlePayments, handlePaymentDecide, handlePayNetworks, handleQuota, handleSubscribe, handleUserLimits } from "./routes/billing.ts";
import { handleAssistant } from "./routes/assistant.ts";
import { handleExport } from "./routes/export.ts";
import { handleReport } from "./routes/report.ts";
import { pushSelfTest } from "./lib/push.ts";
import { handleCallSignal, handleDevice, handleDmRead, handleDms, handleRelay, handleSecrets } from "./routes/p2p.ts";
import { db } from "./lib/db.ts";
import { handleAvatarUpload, handleCron, handleCronEscalate, handleFileUrls, handleManual, handlePush, handleUpload, handleUserRole, handleUsers, handleVersion } from "./routes/misc.ts";
import { handleCallRoom, handleCallRooms } from "./routes/calls.ts";

type Handler = (request: Request) => Promise<Response>;

const ROUTES: Record<string, Handler> = {
  "GET auth/session": handleSession,
  "POST auth/login_with_password": handleLogin,
  "POST auth/register_with_password": handleRegister,
  "POST auth/logout": handleLogout,
  "POST auth/change_password": handleChangePassword,
  "POST auth/forgot_password": handleForgotPassword,
  "POST auth/reset_password": handleResetPassword,
  "GET g37/state": handleState,
  "POST g37/mutate": handleMutate,
  "POST g37/sync": handleSync,
  "POST g37/upload": handleUpload,
  "GET g37/export": handleExport,
  "GET g37/quota": handleQuota,
  "POST g37/calc": handleCalc,
  "POST g37/assistant": handleAssistant,
  "POST g37/subscribe": handleSubscribe,
  "GET g37/pay_networks": handlePayNetworks,
  "GET g37/payments": handlePayments,
  "POST g37/payment_decide": handlePaymentDecide,
  "GET g37/user_limits": handleUserLimits,
  "POST g37/user_limits": handleUserLimits,
  "POST g37/push": handlePush,
  "GET g37/manual_status": handleManual,
  "POST g37/manual_import": handleManual,
  "POST g37/device": handleDevice,
  "GET g37/secrets": handleSecrets,
  "POST g37/relay": handleRelay,
  "GET g37/dms": handleDms,
  "POST g37/dm_read": handleDmRead,
  "POST g37/call_signal": handleCallSignal,
  "POST g37/call_room": handleCallRoom,
  "GET g37/call_rooms": handleCallRooms,
  "POST g37/avatar_upload": handleAvatarUpload,
  "POST g37/file_urls": handleFileUrls,
  "GET users": handleUsers,
  "POST userRole": handleUserRole,
  "GET app/version": () => handleVersion(),
  "POST cron/due": handleCron,
  "POST cron/escalate": handleCronEscalate,
  "GET g37/report": handleReport,
  "POST push/selftest": async (request: Request) => {
    const key = request.headers.get("x-cron-key") ?? "";
    const row = await db.selectFrom("appConfig").select("value").where("key", "=", "cron.key").executeTakeFirst();
    if (!row || !key || key !== row.value) return json({ error: "forbidden" }, 403);
    return json(await pushSelfTest());
  },
  "GET health": () => Promise.resolve(json({ ok: true, at: new Date().toISOString() })),
};

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const path = new URL(request.url).pathname.replace(/^.*?\/api\/?/, "").replace(/\/+$/, "");
  const handler = ROUTES[`${request.method} ${path}`];
  if (!handler) return withCors(json({ error: `Route inconnue : ${request.method} ${path}` }, 404));
  try {
    return withCors(await handler(request));
  } catch (error) {
    console.error(`Erreur ${request.method} ${path}:`, error);
    return withCors(json({ error: error instanceof Error ? error.message : "Erreur serveur" }, 500));
  }
});
