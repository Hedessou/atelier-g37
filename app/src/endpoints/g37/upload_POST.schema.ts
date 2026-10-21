import { z } from "zod";
import superjson from "superjson";

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export const schema = z.object({
  fileName: z.string().min(1).max(200),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
});

export type InputType = z.infer<typeof schema>;
export type OutputType = {
  fileKey: string;
  presignedUrl: string;
  headers: Record<string, string>;
};

export const postG37Upload = async (body: InputType, init?: RequestInit): Promise<OutputType> => {
  const validatedInput = schema.parse(body);
  const result = await fetch(`/_api/g37/upload`, {
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

