import { z } from "zod";

export const schema = z.object({});

// ai / calc : limite gratuite par jour réglée pour cette personne ; null = règle par défaut (3 puis 1).
export type G37UserLimit = { id: number; displayName: string; email: string; jobRole: string; isAdmin: boolean; ai: number | null; calc: number | null };

export type OutputType = { users: G37UserLimit[] };

export const getG37UserLimits = async (init?: RequestInit): Promise<OutputType> => {
  const res = await fetch(`/_api/g37/user_limits`, { method: "GET", ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Limites indisponibles.");
  return data as OutputType;
};

