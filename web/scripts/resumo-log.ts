// Imprime um resumo do log (contagem e somas por coluna) para comparar com o Python.
import { readFileSync } from "node:fs";
import { lerLog } from "../src/lib/dataflash";

const caminho = process.argv[2];
const buf = readFileSync(caminho);
const t0 = performance.now();
const log = lerLog(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
console.error(`lido em ${((performance.now() - t0) / 1000).toFixed(2)} s`);
const saida: Record<string, unknown> = {};
for (const [nome, m] of Object.entries(log)) {
  const cols: Record<string, unknown> = {};
  for (const c of m.ordem) {
    if (c in m.num) {
      let s = 0, nn = 0;
      for (const v of m.num[c]) if (Number.isFinite(v)) { s += v; nn++; }
      cols[c] = [nn, s, m.num[c][0], m.num[c][m.n - 1], m.inteiros.includes(c) ? "int" : "float"];
    } else if (m.arr && c in m.arr) {
      let s = 0;
      for (const v of m.arr[c]) s += v;
      cols[c] = ["arr", m.arr[c].length, s];
    } else cols[c] = ["txt", m.txt[c][0], m.txt[c][m.n - 1]];
  }
  saida[nome] = { n: m.n, cols };
}
console.log(JSON.stringify(saida));
