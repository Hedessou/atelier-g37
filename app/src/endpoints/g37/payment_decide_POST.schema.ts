import { z } from "zod";

export const schema = z.object({
  id: z.number().int().positive(),
  approve: z.boolean(),
});

export type InputType = z.infer<typeof schema>;

export type OutputType = { ok: true; endsAt: string | null };

export const postG37PaymentDecide = async (body: InputType, init?: RequestInit): Promise<OutputType> => {
  const res = await fetch(`/_api/g37/payment_decide`, {
    method: "POST",
    body: JSON.stringify(schema.parse(body)),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Décision impossible.");
  return data as OutputType;
};

