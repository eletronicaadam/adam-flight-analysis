/**
 * dossie.ts — porta de analysis/dossie.py: o "dossiê do voo", um JSON com
 * tudo o que o analista precisa para interpretar um log (ficha, info do
 * log, voos, métricas, eventos com evidência e o que NÃO é confiável).
 */
import type { Log } from "../dataflash";
import type { Ficha } from "../ficha";
import { altitudeMaxima, cortarJanela, duracaoS, origemUs } from "../dadosVoo";
import { pyRound } from "../numerico";
import { resumirVoo } from "./resumo";
import { detectar, GRAVIDADES, LIMITES, type Gravidade } from "./eventos";
import { col } from "../tabela";

/** Converte para o que o JSON aceita, como o _limpar do Python (floats com 4 casas, NaN → null). */
export function limpar(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(limpar);
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>, (x) => limpar(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, limpar(x)]));
  if (typeof v === "number") return Number.isFinite(v) ? (Number.isInteger(v) ? v : pyRound(v, 4)) : null;
  return v;
}

const IMPORTANTES = ["AHRS_ORIENTATION", "AHRS_EKF_TYPE", "ARSPD_TYPE", "ARSPD_USE", "BATT_MONITOR", "BATT_CAPACITY",
  "COMPASS_USE", "THR_FAILSAFE", "FS_LONG_ACTN", "FS_SHORT_ACTN", "INS_LOG_BAT_MASK", "LOG_BITMASK",
  "AIRSPEED_MIN", "AIRSPEED_CRUISE", "PTCH_LIM_MAX_DEG", "PTCH_LIM_MIN_DEG"];

/** Último valor de cada parâmetro (PARM). */
export function parametros(dados: Log): Record<string, number> {
  const parm = dados.PARM;
  const r: Record<string, number> = {};
  if (!parm || !parm.txt.Name) return r;
  const nomes = parm.txt.Name, valores = col(parm, "Value");
  for (let i = 0; i < parm.n; i++) r[nomes[i]] = valores[i];
  return r;
}

export function infoDoLog(dados: Log, origem: number) {
  const textos = dados.MSG?.txt.Message ?? [];
  const firmware = textos.find((x) => /^(ArduPlane|ArduCopter|ArduRover|ArduSub)/.test(x)) ?? null;
  let placa: string | null = null;
  if (firmware) {
    const i = textos.indexOf(firmware);
    const cand = textos.slice(i + 1, i + 4).filter((x) => !/^(ChibiOS|Param|RC )/.test(x));
    placa = cand.length ? (cand[0].trim().split(/\s+/)[0] ?? null) : null;
  }
  const p = parametros(dados);
  return {
    firmware,
    placa,
    duracao_s: pyRound(duracaoS(dados, origem), 1),
    tipos_de_mensagem: Object.fromEntries(Object.keys(dados).sort().map((k) => [k, dados[k].n])),
    parametros_importantes: Object.fromEntries(IMPORTANTES.filter((k) => k in p).map((k) => [k, p[k]])),
  };
}

export type Dossie = Record<string, unknown> & {
  veredito_automatico: string;
  contagem_eventos: Record<Gravidade, number>;
};

/** Monta o dossiê (já limpo para JSON) de um log inteiro. */
export function gerarDossie(dados: Log, ficha: Ficha, arquivo: string, geradoEm = new Date()): Dossie {
  const origem = origemUs(dados);
  const deteccao = detectar(dados, ficha);
  const voos = deteccao.voos.map((voo) => {
    const janela = cortarJanela(dados, voo.inicio_s, voo.fim_s, origem);
    const metricas: Record<string, unknown> = resumirVoo(janela);
    const alt = altitudeMaxima(dados, janela, origem);
    metricas.altitude_relativa_solo = { maxima_barometro_m: alt.BARO, maxima_gps_m: alt.GPS };
    return { voo, metricas };
  });
  const contagem = Object.fromEntries(GRAVIDADES.map((g) => [g, deteccao.eventos.filter((e) => e.gravidade === g).length])) as
    Record<Gravidade, number>;
  const veredito = contagem.critico ? "problemas críticos" : contagem.atencao ? "atenção" : "voo normal";
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = geradoEm;
  const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return limpar({
    arquivo,
    gerado_em: iso,
    tempo: "segundos desde a primeira mensagem do log (mm:ss = minutos:segundos)",
    ficha: Object.fromEntries(Object.entries(ficha).filter(([k]) => !k.startsWith("_"))),
    log: infoDoLog(dados, origem),
    veredito_automatico: veredito,
    contagem_eventos: contagem,
    voos,
    bateria: deteccao.bateria,
    atitude: deteccao.atitude,
    qualidade_dados: deteccao.qualidade_dados,
    eventos: deteccao.eventos,
    limites_usados: Object.fromEntries(Object.entries(LIMITES).map(([k, [valor, fonte]]) => [k, { valor, fonte }])),
  }) as Dossie;
}
