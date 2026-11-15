// Gera o dossiê de um log pelo código do site, para comparar com analysis/dossie.py.
//   npx tsx scripts/dossie.ts LOG.bin [FICHA.toml]
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { lerLog } from "../src/lib/dataflash";
import { fichaDoToml } from "../src/lib/ficha";
import { gerarDossie } from "../src/lib/analise/dossie";

const [caminho, caminhoFicha] = process.argv.slice(2);
const buf = readFileSync(caminho);
const log = lerLog(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const ficha = fichaDoToml(readFileSync(caminhoFicha ?? new URL("../../aeronave.toml", import.meta.url), "utf8"));
const t0 = performance.now();
const d = gerarDossie(log, ficha, basename(caminho));
console.error(`dossiê em ${((performance.now() - t0) / 1000).toFixed(2)} s`);
console.log(JSON.stringify(d));
