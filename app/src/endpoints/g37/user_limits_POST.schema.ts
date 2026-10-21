import { z } from "zod";

const limit = z.number().int().min(0).max(1000).nullable();

export const schema = z.object({
  userId: z.number().int().positive(),
  ai: limit,
  calc: limit,
});

export type InputType = z.infer<typeof schema>;

export type OutputType = { ok: true };

export const postG37UserLimits = async (body: InputType, init?: RequestInit): Promise<OutputType> => {
  const res = await fetch(`/_api/g37/user_limits`, {
    method: "POST",
    body: JSON.stringify(schema.parse(body)),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Enregistrement impossible.");
  return data as OutputType;
};

