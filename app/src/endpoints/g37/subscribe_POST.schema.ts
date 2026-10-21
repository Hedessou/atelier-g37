import { z } from "zod";
import type { G37QuotaStatus } from "../../helpers/g37Plans";

export const schema = z.object({
  plan: z.enum(["day", "three_days", "week", "month"]),
  country: z.string().length(2),
  network: z.string().min(1).max(60),
  phone: z.string().trim().min(6, "Numéro Mobile Money requis.").max(25),
  otp: z.string().trim().max(20).optional(),
});

export type InputType = z.infer<typeof schema>;

// pushed : la demande de paiement est arrivée sur le téléphone, le client la confirme avec son code.
// checkoutUrl : ce réseau demande d'ouvrir une page de paiement.
// otpRequired : ce réseau demande d'abord un code de paiement (ex. Orange Money CI/BF).
export type OutputType = {
  activated: boolean;
  pushed: boolean;
  checkoutUrl: string | null;
  otpRequired: boolean;
  message: string | null;
  quota: G37QuotaStatus | null;
};

export const postG37Subscribe = async (body: InputType, init?: RequestInit): Promise<OutputType> => {
  const res = await fetch(`/_api/g37/subscribe`, {
    method: "POST",
    body: JSON.stringify(schema.parse(body)),
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Paiement impossible pour le moment.");
  return data as OutputType;
};

