// Fonction « wa-app » (01/11/2026) : routes du Robot WhatsApp G37 qui agissent dans l'app.
// Séparée de « api » pour ne pas redéployer le serveur de l'app : elle réutilise son code depuis GitHub (voir wa.ts).
//   Robot (en-tête x-wa-key) : POST wa/mutate · POST wa/ask_call · POST wa/ask_answer
//   App (session x-g37-token) : GET g37/ask · POST g37/ask_answer · GET g37/ask_audio
import { CORS, json, withCors } from "https://raw.githubusercontent.com/Hedessou/atelier-g37/48803080ff763721c0470f9c58fd3193d12a4445/supabase/functions/api/lib/http.ts";
import { handleAsk, handleAskAnswer, handleAskAudio, handleWaAskAnswer, handleWaAskCall } from "./wa.ts";
import { handleWaMutateAll } from "./people.ts";

type Handler = (request: Request) => Promise<Response>;
const ROUTES: Record<string, Handler> = {
  "POST wa/mutate": handleWaMutateAll,
  "POST wa/ask_call": handleWaAskCall,
  "POST wa/ask_answer": handleWaAskAnswer,
  "GET g37/ask": handleAsk,
  "POST g37/ask_answer": handleAskAnswer,
  "GET g37/ask_audio": handleAskAudio,
  "GET health": () => Promise.resolve(json({ ok: true, at: new Date().toISOString() })),
};

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const path = new URL(request.url).pathname.replace(/^.*?\/wa-app\/?/, "").replace(/\/+$/, "");
  const handler = ROUTES[`${request.method} ${path}`];
  if (!handler) return withCors(json({ error: `Route inconnue : ${request.method} ${path}` }, 404));
  try {
    return withCors(await handler(request));
  } catch (error) {
    console.error(`wa-app ${request.method} ${path}:`, error);
    return withCors(json({ error: error instanceof Error ? error.message : "Erreur serveur" }, 500));
  }
});
