import { z } from "zod";
import superjson from "superjson";

// Jeton Firebase de ce téléphone (notifications Android).
export const schema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("save"), token: z.string().min(10).max(4096), platform: z.string().max(20).default("android") }),
  z.object({ op: z.literal("remove"), token: z.string().min(10).max(4096) }),
]);

export type InputType = z.input<typeof schema>;
export type OutputType = { success: true };

export const postG37Push = async (body: InputType, init?: RequestInit): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/g37/push`, {
    method: "POST",
    body: superjson.stringify(validatedInput),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!result.ok) {
    const errorObject = superjson.parse<{ error: string }>(await result.text());
    throw new Error(errorObject.error);
  }
  return superjson.parse<OutputType>(await result.text());
};
