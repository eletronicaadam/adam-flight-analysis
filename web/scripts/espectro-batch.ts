// Espectro do batch sampler (ISBH/ISBD) de um log, para comparar com analysis/espectro.py.
import { readFileSync } from "node:fs";
import { lerLog } from "../src/lib/dataflash";
import { origemBruta } from "../src/lib/analise/atitude";
import { espectroBatch, lotesBatchSampler, picos } from "../src/lib/analise/espectro";

const buf = readFileSync(process.argv[2]);
const dados = lerLog(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const lotes = lotesBatchSampler(dados, origemBruta(dados));
const r: Record<string, unknown> = {};
for (const sensor of ["acelerometro", "giroscopio"]) {
  const e = espectroBatch(lotes, 0, 100, sensor)!;
  r[sensor] = { freq: Array.from(e.freq), eixos: e.eixos.map((x) => Array.from(x)), taxa: e.taxa, lotes: e.lotes,
    picos: picos(e.freq, e.freq.map((_, k) => Math.max(...e.eixos.map((x) => x[k])))) };
}
console.log(JSON.stringify(r));
