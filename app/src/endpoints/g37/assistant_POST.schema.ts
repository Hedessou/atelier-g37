import { z } from "zod";

export const schema = z.object({
  message: z.string().min(1).max(4000),
  language: z.enum(["fr", "en"]).default("fr"),
  // Le contexte G37 contient les 28 machines et l’historique atelier ; il peut dépasser 30 k caractères.
  context: z.string().max(120000).default(""),
  // Derniers échanges, pour que l'assistant comprenne les questions de suivi.
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4000) })).max(12).default([]),
});

export type AssistantRequest = z.infer<typeof schema>;

