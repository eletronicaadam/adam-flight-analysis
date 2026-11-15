// Gera o relatório PDF e as exportações CSV/ZIP de um trecho pelo código do site.
//   npx tsx scripts/relatorio.ts LOG.bin PASTA_SAIDA [INI FIM]
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { lerLog } from "../src/lib/dataflash";
import { fichaDoToml } from "../src/lib/ficha";
import { Sessao } from "../src/lib/sessao";
import { gerarRelatorioPdf } from "../src/relatorioPdf";

const [caminho, saida, a, b] = process.argv.slice(2);
const buf = readFileSync(caminho);
const s = new Sessao(lerLog(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), basename(caminho), buf.length);
const ficha = fichaDoToml(readFileSync(new URL("../../aeronave.toml", import.meta.url), "utf8"));
const [ini, fim] = a ? [Number(a), Number(b)] : s.info.trechoEmVoo!.map((x) => Math.round(x * 10) / 10);
const t0 = performance.now();
const pdf = gerarRelatorioPdf(s.relatorio(ini, fim, ficha));
writeFileSync(join(saida, "relatorio.pdf"), Buffer.from(await pdf.arrayBuffer()));
writeFileSync(join(saida, "resumo.csv"), s.csvResumo(ini, fim, ficha));
writeFileSync(join(saida, "eventos.csv"), s.csvEventos(ini, fim, ficha));
writeFileSync(join(saida, "mensagens.zip"), s.zipTrecho(ini, fim));
console.error(`trecho ${ini}–${fim}; tudo em ${((performance.now() - t0) / 1000).toFixed(2)} s`);
