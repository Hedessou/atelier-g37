// Offres d'abonnement « illimité » (questions IA + calculs). Partagé app / serveur.
export const g37Plans = {
  // Seul ce compte (le propriétaire, Hedessou) peut régler les limites gratuites de chaque personne.
  OWNER_USER_ID: 1,
  FREE_PER_DAY: 3,
  // À partir du lendemain du premier avertissement, hors abonnement.
  FREE_PER_DAY_AFTER_WARNING: 1,
  list: [
    { key: "day", price: 200, days: 1, fr: "1 jour illimité", en: "1 day unlimited" },
    { key: "three_days", price: 500, days: 3, fr: "3 jours illimités", en: "3 days unlimited" },
    { key: "week", price: 1000, days: 7, fr: "1 semaine illimitée", en: "1 week unlimited" },
    { key: "month", price: 2000, days: 30, fr: "1 mois illimité", en: "1 month unlimited" },
  ] as const,
  byKey(key: string) {
    return g37Plans.list.find((p) => p.key === key) ?? null;
  },
};

export type G37PlanKey = (typeof g37Plans.list)[number]["key"];

export type G37QuotaStatus = {
  unlimited: boolean;
  isAdmin: boolean;
  subscription: { plan: G37PlanKey; endsAt: string } | null;
  ai: { used: number; limit: number; remaining: number | null };
  calc: { used: number; limit: number; remaining: number | null };
  pendingRequest: { id: number; plan: G37PlanKey; amount: number; createdAt: string; checkoutUrl: string | null } | null;
};
