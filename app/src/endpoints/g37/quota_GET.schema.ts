import { z } from "zod";
import type { G37QuotaStatus } from "../../helpers/g37Plans";

export const schema = z.object({});

export type OutputType = G37QuotaStatus;

export const getG37Quota = async (init?: RequestInit): Promise<OutputType> => {
  const res = await fetch(`/_api/g37/quota`, { method: "GET", ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Quota indisponible.");
  return data as OutputType;
};

