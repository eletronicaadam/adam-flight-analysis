// Copia os painéis HTML/JS do projeto Python (visualization/*_web) para
// public/, para o site usar exatamente o mesmo código (uma fonte só).
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const nome of ["painel_voo_web", "replay_voo_web"]) {
  const destino = join(raiz, "web", "public", nome);
  rmSync(destino, { recursive: true, force: true });
  cpSync(join(raiz, "visualization", nome), destino, { recursive: true });
}
console.log("painéis copiados para web/public/");
