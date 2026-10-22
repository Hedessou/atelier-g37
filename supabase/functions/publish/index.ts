// Fonction « publish » : appelée uniquement par la fabrication automatique (GitHub Actions)
// pour déposer une nouvelle version de l'app et l'annoncer aux téléphones.
//   POST /publish/prepare  { bundleVersion, nativeVersionCode } -> adresses d'envoi des fichiers
//   POST /publish/commit   { bundleVersion, bundleChecksum, nativeVersionCode, minNativeVersionCode?, apkChecksum?, notes? }
// Protégée par l'en-tête x-publish-key (valeur gardée en base : app_config 'publish.key').
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const supa = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BUCKET = "app-updates";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const publicUrl = (path: string) => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
const bundlePath = (v: string) => `bundles/${v}.zip`;
const apkPath = (v: string) => `apk/atelier-g37-${v}.apk`;

async function setConfig(values: Record<string, string | null>) {
  const rows = Object.entries(values).map(([key, value]) => ({ key, value: value ?? "", updated_at: new Date().toISOString() }));
  const { error } = await supa.from("app_config").upsert(rows, { onConflict: "key" });
  if (error) throw new Error(error.message);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const { data: keyRow } = await supa.from("app_config").select("value").eq("key", "publish.key").maybeSingle();
  const given = req.headers.get("x-publish-key") ?? "";
  if (!keyRow?.value || !given || !sameText(given, keyRow.value)) return json({ error: "forbidden" }, 403);

  const action = new URL(req.url).pathname.replace(/^.*?\/publish\/?/, "");
  const body = await req.json().catch(() => ({}));
  const bundleVersion = String(body.bundleVersion ?? "");
  if (!VERSION_RE.test(bundleVersion)) return json({ error: "bundleVersion invalide" }, 400);

  if (action === "prepare") {
    const out: Record<string, string> = {};
    for (const [name, path] of [["bundle", bundlePath(bundleVersion)], ["apk", apkPath(bundleVersion)]]) {
      const { data, error } = await supa.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
      if (error || !data) return json({ error: `upload ${name}: ${error?.message}` }, 500);
      out[name] = data.signedUrl;
    }
    return json(out);
  }

  if (action === "commit") {
    const checksum = String(body.bundleChecksum ?? "");
    if (!/^[0-9a-f]{64}$/.test(checksum)) return json({ error: "bundleChecksum invalide" }, 400);
    const nativeVersionCode = Number(body.nativeVersionCode);
    if (!Number.isInteger(nativeVersionCode) || nativeVersionCode < 1) return json({ error: "nativeVersionCode invalide" }, 400);
    const minNative = body.minNativeVersionCode == null ? null : Number(body.minNativeVersionCode);
    const apkChecksum = /^[0-9a-f]{64}$/.test(String(body.apkChecksum ?? "")) ? String(body.apkChecksum) : null;
    await setConfig({
      "app.bundleVersion": bundleVersion,
      "app.bundleUrl": publicUrl(bundlePath(bundleVersion)),
      "app.bundleChecksum": checksum,
      "app.nativeVersionCode": String(nativeVersionCode),
      "app.minNativeVersionCode": minNative && Number.isInteger(minNative) ? String(minNative) : null,
      "app.apkUrl": publicUrl(apkPath(bundleVersion)),
      "app.apkChecksum": apkChecksum,
      "app.notes": body.notes ? String(body.notes).slice(0, 500) : null,
    });
    // Ménage : on garde les 5 dernières versions.
    for (const folder of ["bundles", "apk"]) {
      const { data } = await supa.storage.from(BUCKET).list(folder, { limit: 100, sortBy: { column: "created_at", order: "desc" } });
      const old = (data ?? []).slice(5).map((f) => `${folder}/${f.name}`);
      if (old.length) await supa.storage.from(BUCKET).remove(old);
    }
    return json({ ok: true, bundleUrl: publicUrl(bundlePath(bundleVersion)), apkUrl: publicUrl(apkPath(bundleVersion)) });
  }

  return json({ error: "action inconnue" }, 404);
});
