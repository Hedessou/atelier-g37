import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Chemins relatifs : l'app est servie depuis les fichiers du téléphone (et depuis les mises à jour téléchargées).
  base: "./",
  build: {
    outDir: "dist",
    target: "es2020",
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
  css: { modules: { localsConvention: "camelCase" } },
});
