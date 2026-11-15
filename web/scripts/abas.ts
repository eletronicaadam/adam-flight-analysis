// Saída das abas (Saúde, Vibração, Aerodinâmica, Replay, Explorador) pelo código do
// site, para comparar com scripts/abas_py.py.  npx tsx scripts/abas.ts LOG [FICHA] [INI FIM]
import { readFileSync } from "node:fs";
import { lerLog } from "../src/lib/dataflash";
import { fichaDoToml } from "../src/lib/ficha";
import { detectarTrechoEmVoo, origemUs, unidades } from "../src/lib/dadosVoo";
import { limpar } from "../src/lib/analise/dossie";
import { detectar } from "../src/lib/analise/eventos";
import { lotesBatchSampler } from "../src/lib/analise/espectro";
import { prepararSaude } from "../src/lib/abas/saude";
import { prepararVibracao } from "../src/lib/abas/vibracao";
import { prepararAero } from "../src/lib/abas/aerodinamica";
import { barometroRuim, eventosParaReplay, prepararReplay } from "../src/lib/abas/replay";
import { opcoes, painelExplorador, PADRAO } from "../src/lib/abas/explorador";

const [caminho, caminhoFicha, a, b] = process.argv.slice(2);
const buf = readFileSync(caminho);
const dados = lerLog(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const ficha = fichaDoToml(readFileSync(caminhoFicha && caminhoFicha !== "-" ? caminhoFicha : new URL("../../aeronave.toml", import.meta.url), "utf8"));
const origem = origemUs(dados);
const un = unidades(dados);
const voo = detectarTrechoEmVoo(dados, origem)!;
const [ini, fim] = a ? [Number(a), Number(b)] : [Math.round(voo[0] * 10) / 10, Math.round(voo[1] * 10) / 10];
const t0 = performance.now();
const vib = prepararVibracao(dados, origem, ini, fim, lotesBatchSampler(dados, origem), "imu");
const ruim = barometroRuim(dados, origem, ini, fim);
const op = opcoes(dados);
const saida = {
  trecho: [ini, fim],
  saude: prepararSaude(dados, origem, un, ini, fim),
  vibracao: { ...vib, espectrograma: vib.espectrograma && { t: vib.espectrograma.t, freq: vib.espectrograma.freq,
    db_soma: vib.espectrograma.db.reduce((s, l) => s + l.reduce((x, y) => x + y, 0), 0) } },
  aero: prepararAero(dados, origem, ficha, ini, fim, { massa: ficha.massa_decolagem_kg ?? 5, area: ficha.area_asa_m2 ?? 1,
    envergadura: ficha.envergadura_m ?? 2, temperatura: 25, usarVento: null }),
  replay: { barometro_ruim: ruim, payload: prepararReplay(dados, origem, ficha, ini, fim, ruim ? "GPS" : "barômetro",
    eventosParaReplay(detectar(dados, ficha).eventos)) },
  explorador: { opcoes: op.opcoes, linhas: op.linhas,
    painel: painelExplorador(dados, origem, un, ini, fim, PADRAO.filter((o) => op.opcoes.includes(o)), "campo", 0, true) },
};
console.error(`abas em ${((performance.now() - t0) / 1000).toFixed(2)} s; trecho ${ini}–${fim}`);
console.log(JSON.stringify(limpar(saida)));
