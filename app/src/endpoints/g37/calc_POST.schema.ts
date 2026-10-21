import { z } from "zod";
import type { G37QuotaStatus } from "../../helpers/g37Plans";

export const schema = z.object({});

export type InputType = z.infer<typeof schema>;

// ok=false : limite gratuite atteinte, il faut s'abonner ou attendre demain.
export type OutputType = { ok: boolean; quota: G37QuotaStatus };

export const postG37Calc = async (init?: RequestInit): Promise<OutputType> => {
  const res = await fetch(`/_api/g37/calc`, {
    method: "POST",
    body: JSON.stringify({}),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 402 && data.quota) return { ok: false, quota: data.quota };
  if (!res.ok) throw new Error(data.error || "Calcul indisponible.");
  return { ok: true, quota: data.quota };
};

