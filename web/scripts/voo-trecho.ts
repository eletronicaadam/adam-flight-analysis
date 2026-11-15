// Calcula info do log + aba Voo para um trecho e imprime em JSON (comparação com o Python).
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { lerLog } from "../src/lib/dataflash";
import { Sessao } from "../src/lib/sessao";

const [caminho, ini, fim] = process.argv.slice(2);
const buf = readFileSync(caminho);
const s = new Sessao(lerLog(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), basename(caminho), buf.length);
const r1 = (x: number) => Math.round(x * 10) / 10;
const trecho = ini ? [Number(ini), Number(fim)] : (s.info.trechoEmVoo ?? [0, s.info.duracao]).map(r1);
const r = s.voo(trecho[0], trecho[1]);
console.log(JSON.stringify({ duracao: s.info.duracao, trechoEmVoo: s.info.trechoEmVoo, trecho, resumo: r.resumo, painel: r.painel, kml_len: r.kml?.length ?? null },
  (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v)));
