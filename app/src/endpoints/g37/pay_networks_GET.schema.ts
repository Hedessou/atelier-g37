import { z } from "zod";

export const schema = z.object({ country: z.string().length(2) });

export type OutputType = { networks: Array<{ code: string; name: string }> };

export const getG37PayNetworks = async (country: string, init?: RequestInit): Promise<OutputType> => {
  const res = await fetch(`/_api/g37/pay_networks?country=${encodeURIComponent(country)}`, { method: "GET", ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Réseaux indisponibles.");
  return data as OutputType;
};

