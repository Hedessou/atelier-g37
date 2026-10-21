import superjson from "superjson";

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-g37-token, x-client-info, apikey, authorization, x-app-version, x-push-token",
  "Access-Control-Expose-Headers": "content-disposition",
  "Access-Control-Max-Age": "86400",
};

// Réponse au format superjson (comme sur Floot : le client la lit avec superjson.parse).
export const sj = (data: unknown, status = 200) =>
  new Response(superjson.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export async function readSuperjson<T = unknown>(request: Request): Promise<T> {
  const text = await request.text();
  try {
    const parsed = JSON.parse(text);
    // Le client envoie du superjson ({ json, meta }) ; on accepte aussi du JSON simple.
    if (parsed && typeof parsed === "object" && "json" in parsed && Object.keys(parsed).every((k) => k === "json" || k === "meta")) {
      return superjson.parse<T>(text);
    }
    return parsed as T;
  } catch {
    return superjson.parse<T>(text);
  }
}
