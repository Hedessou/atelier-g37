// Client serveur SasPay (https://docs.saspay.me) — paiement mobile money direct (softpay).
// La clé secrète reste côté serveur (secret SASPAY_SECRET_KEY, jamais dans l'app).
const BASE = "https://api.saspay.me/api/v1";

function secretKey(): string {
  const key = Deno.env.get("SASPAY_SECRET_KEY");
  if (!key) throw new Error("Paiement SasPay non configuré : la clé API SASPAY_SECRET_KEY est manquante.");
  return key;
}

class SasPayError extends Error {
  code: string | null;
  status: number;
  constructor(message: string, code: string | null, status: number) {
    super(message);
    this.name = "SasPayError";
    this.code = code;
    this.status = status;
  }
}

// deno-lint-ignore no-explicit-any
function errorOf(body: any, status: number): SasPayError {
  const err = body?.error ?? body;
  if (err && typeof err.message === "string") return new SasPayError(err.message, typeof err.code === "string" ? err.code : null, status);
  if (err && typeof err === "object") {
    const first = Object.entries(err).find(([k]) => k !== "success" && k !== "code");
    if (first) return new SasPayError(`${first[0]} : ${Array.isArray(first[1]) ? first[1].join(", ") : String(first[1])}`, "validation", status);
  }
  return new SasPayError(`Erreur SasPay (${status}).`, null, status);
}

async function call(path: string, init: RequestInit & { auth?: boolean; idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (init.auth !== false) headers.Authorization = `Bearer ${secretKey()}`;
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  const res = await fetch(`${BASE}${path}`, { method: init.method, body: init.body, headers });
  // deno-lint-ignore no-explicit-any
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body?.success === false) throw errorOf(body, res.status);
  return body?.data ?? body;
}

const COUNTRIES = [
  { code: "TG", name: "Togo", dial: "228" },
  { code: "BJ", name: "Bénin", dial: "229" },
  { code: "CI", name: "Côte d'Ivoire", dial: "225" },
  { code: "BF", name: "Burkina Faso", dial: "226" },
  { code: "SN", name: "Sénégal", dial: "221" },
  { code: "ML", name: "Mali", dial: "223" },
  { code: "NE", name: "Niger", dial: "227" },
] as const;

function normalizePhone(country: string, raw: string): string {
  const dial = COUNTRIES.find((c) => c.code === country)?.dial;
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) digits = "+" + digits.slice(2);
  if (digits.startsWith("+")) return "+" + digits.slice(1).replace(/\D/g, "");
  if (dial && digits.startsWith(dial) && digits.length > dial.length + 7) return "+" + digits;
  return "+" + (dial ?? "") + digits;
}

async function networks(country: string): Promise<Array<{ code: string; name: string }>> {
  // deno-lint-ignore no-explicit-any
  const countries: any = await call(`/countries/?is_active=true`, { auth: false });
  // deno-lint-ignore no-explicit-any
  const list: any[] = Array.isArray(countries) ? countries : countries?.results ?? [];
  // deno-lint-ignore no-explicit-any
  const id = list.find((c: any) => c.iso_code === country)?.id;
  if (!id) return [];
  const out: Array<{ code: string; name: string }> = [];
  for (let page = 1; page <= 5; page++) {
    const data = await call(`/networks/?page=${page}&page_size=100`);
    // deno-lint-ignore no-explicit-any
    const rows: any[] = Array.isArray(data) ? data : data?.results ?? [];
    for (const n of rows) {
      if (n.country === id && n.is_active !== false && !/crypto|card|carte/i.test(`${n.code} ${n.name}`)) out.push({ code: String(n.code), name: String(n.name) });
    }
    if (Array.isArray(data) || !data?.next) break;
  }
  return out;
}

async function softpay(input: {
  amount: number; country: string; network: string; phone: string; email: string; name: string;
  description: string; otp: string | null; returnUrl: string | null;
  metadata: Record<string, string | number>; idempotencyKey: string;
}): Promise<{ id: string; status: string; checkoutUrl: string | null }> {
  const [first, ...rest] = input.name.trim().split(/\s+/);
  const data = await call("/payments/softpay/", {
    method: "POST",
    idempotencyKey: input.idempotencyKey,
    body: JSON.stringify({
      amount: input.amount.toFixed(2),
      currency: "XOF",
      country: input.country,
      network: input.network,
      description: input.description,
      customer: { email: input.email, first_name: first || "Client", last_name: rest.join(" ") || "G37", phone: input.phone },
      ...(input.otp ? { otp: input.otp } : {}),
      ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
      metadata: input.metadata,
    }),
  });
  if (!data?.id) throw new SasPayError("Réponse SasPay incomplète (paiement).", null, 502);
  return { id: String(data.id), status: String(data.status ?? "PENDING").toUpperCase(), checkoutUrl: data.checkout_url ? String(data.checkout_url) : null };
}

async function paymentStatus(id: string): Promise<{ status: string; paid: boolean; closed: boolean }> {
  const data = await call(`/payments/${encodeURIComponent(id)}/verify/`, { method: "GET" });
  const status = String(data?.status ?? "").toUpperCase();
  return { status, paid: status === "SUCCESS", closed: ["FAILED", "CANCELLED", "CANCELED", "EXPIRED", "REJECTED"].includes(status) };
}

async function checkoutStatus(id: string): Promise<{ status: string; paid: boolean; closed: boolean }> {
  const data = await call(`/checkout-sessions/${encodeURIComponent(id)}/status/`, { method: "GET" });
  const status = String(data?.status ?? "").toUpperCase();
  const tx = String(data?.transaction_status ?? "").toUpperCase();
  const paid = status === "PAID" || tx === "SUCCESS";
  const closed = !paid && ["EXPIRED", "CANCELLED", "CANCELED"].includes(status);
  return { status, paid, closed };
}

export const g37SasPay = { COUNTRIES, normalizePhone, networks, softpay, paymentStatus, checkoutStatus };
