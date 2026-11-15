import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  // Só o app entra na varredura de dependências (os painéis em public/ têm as libs deles).
  optimizeDeps: { entries: ["index.html"] },
  build: { target: "es2022" },
  // Em desenvolvimento, permite abrir os logs de ../data e ../tests (testes no navegador).
  server: { fs: { allow: [".."] } },
});
