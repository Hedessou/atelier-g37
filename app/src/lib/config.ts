// Adresses du serveur (Supabase). Les clés ci-dessous sont publiques : elles ne donnent accès à aucune donnée,
// toutes les tables sont fermées et chaque action passe par le serveur avec la session de la personne.
export const SUPABASE_URL = "https://yrtoimldmzlnmsoapcij.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlydG9pbWxkbXpsbm1zb2FwY2lqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2MDU5MzEsImV4cCI6MjEwODE4MTkzMX0.bcOMyqafWPSzJh0bYKJLcv34oED4xykWlzQzQN2IX5M";
export const API_BASE = `${SUPABASE_URL}/functions/v1/api/`;

// Fixés au moment de la fabrication par GitHub (voir .github/workflows/android.yml).
export const BUNDLE_VERSION: string = import.meta.env.VITE_BUNDLE_VERSION ?? "dev";
export const PUSH_ENABLED: boolean = import.meta.env.VITE_PUSH_ENABLED === "1";
