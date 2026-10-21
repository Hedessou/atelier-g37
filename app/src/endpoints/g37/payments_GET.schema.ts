import { z } from "zod";
import type { G37PlanKey } from "../../helpers/g37Plans";

export const schema = z.object({});

export type G37PaymentRow = {
  id: number;
  userName: string;
  userEmail: string;
  plan: G37PlanKey;
  amount: number;
  status: "pending" | "active" | "rejected";
  checkoutId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  decidedBy: string | null;
};

export type OutputType = {
  pending: G37PaymentRow[];
  recent: G37PaymentRow[];
};

export const getG37Payments = async (init?: RequestInit): Promise<OutputType> => {
  const res = await fetch(`/_api/g37/payments`, { method: "GET", ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Paiements indisponibles.");
  return data as OutputType;
};

