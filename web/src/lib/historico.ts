/**
 * historico.ts — resumo de cada voo de um log para o histórico (o que o
 * exportar_csv.py grava em historico_voos.csv: métricas "achatadas" em
 * colunas categoria_chave), mais data GPS, veredito e eventos.
 */
import type { Log } from "./dataflash";
import { altitudeMaxima, cortarJanela, duracaoS, gpsValido, origemUs, TIPOS_DO_PAINEL } from "./dadosVoo";
import { col } from "./tabela";
import { resumirVoo } from "./analise/resumo";
import { GRAVIDADES, type Gravidade, type ResultadoEventos } from "./analise/eventos";
import { limpar } from "./analise/dossie";

export type ValorHistorico = number | string | null;

export interface RegistroVoo {
  /** nome|tamanho|n.º do voo: abrir o mesmo log de novo substitui a linha. */
  id: string;
  arquivo: string;
  voo: number | null;
  /** Data/hora UTC do início do voo pelo GPS (ISO), se houver. */
  data: string | null;
  inicio_s: number | null;
  fim_s: number | null;
  veredito: string | null;
  eventos: Partial<Record<Gravidade, number>>;
  metricas: Record<string, ValorHistorico>;
  salvo_em: string;
  /** "site" ou "csv" (importado do historico_voos.csv do Python). */
  origem: "site" | "csv";
}

const SEGUNDOS_GPS_UTC = 18; // segundos bissextos entre GPS e UTC (desde 2017)
const EPOCA_GPS_MS = Date.UTC(1980, 0, 6);

/** Data UTC (ISO) do primeiro fix GPS a partir de `inicio` (s desde o início do log). */
export function dataGps(dados: Log, origem: number, inicio: number): string | null {
  const gps = gpsValido(dados);
  if (!gps || !gps.num.GWk || !gps.num.GMS) return null;
  const t = col(gps, "TimeUS"), wk = gps.num.GWk, ms = gps.num.GMS;
  for (let i = 0; i < gps.n; i++) {
    if ((t[i] - origem) / 1e6 >= inicio && wk[i] > 0) {
      const instante = EPOCA_GPS_MS + wk[i] * 7 * 86400e3 + ms[i] - SEGUNDOS_GPS_UTC * 1e3;
      return new Date(instante - ((t[i] - origem) / 1e6 - inicio) * 1e3).toISOString().slice(0, 19) + "Z";
    }
  }
  return null;
}

/** Métricas como no exportar_csv.py: {categoria: {chave: v}} → {categoria_chave: v}. */
export function achatar(resumo: Record<string, unknown>): Record<string, ValorHistorico> {
  const linha: Record<string, ValorHistorico> = {};
  for (const [cat, valores] of Object.entries(resumo)) {
    if (!valores || typeof valores !== "object") continue;
    for (const [k, v] of Object.entries(valores as Record<string, unknown>)) {
      linha[`${cat}_${k}`] = typeof v === "number" || typeof v === "string" ? v : null;
    }
  }
  return linha;
}

/** Uma linha por voo detectado (ou uma para o log inteiro, se nenhum voo foi detectado). */
export function registrosDoLog(dados: Log, eventos: ResultadoEventos, nome: string, tamanho: number,
                               agora = new Date()): RegistroVoo[] {
  const origem = origemUs(dados);
  const painel: Log = {};
  for (const t of TIPOS_DO_PAINEL) if (dados[t]) painel[t] = dados[t];
  const trechos: [number, number][] = eventos.voos.length
    ? eventos.voos.map((v) => [v.inicio_s, v.fim_s])
    : [[0, duracaoS(dados, origem)]];
  return trechos.map(([ini, fim], k) => {
    const janela = cortarJanela(dados, ini, fim, origem);
    const resumo: Record<string, unknown> = resumirVoo(janela);
    const alt = altitudeMaxima(dados, janela, origem);
    resumo.altitude_relativa_solo = { maxima_barometro_m: alt.BARO, maxima_gps_m: alt.GPS };
    resumo.voo = { duracao_s: fim - ini };
    // Um voo só: os mesmos eventos (e veredito) do dossiê. Vários: os que se
    // sobrepõem a cada voo (±30 s); sem instante = vale para o log todo.
    const doVoo = eventos.voos.length > 1
      ? eventos.eventos.filter((e) => e.inicio_s === null || ((e.fim_s ?? e.inicio_s) >= ini - 30 && e.inicio_s <= fim + 30))
      : eventos.eventos;
    const contagem = Object.fromEntries(GRAVIDADES.map((g) => [g, doVoo.filter((e) => e.gravidade === g).length])) as
      Record<Gravidade, number>;
    const veredito = contagem.critico ? "problemas críticos" : contagem.atencao ? "atenção" : "voo normal";
    const varios = eventos.voos.length > 1;
    return {
      id: `${nome}|${tamanho}|${eventos.voos.length ? k + 1 : 0}`,
      arquivo: varios ? `${nome} · voo ${k + 1}` : nome,
      voo: eventos.voos.length ? k + 1 : null,
      data: dataGps(dados, origem, ini),
      inicio_s: eventos.voos.length ? ini : null,
      fim_s: eventos.voos.length ? fim : null,
      veredito: eventos.voos.length ? veredito : "sem voo detectado",
      eventos: contagem,
      metricas: limpar(achatar(resumo)) as Record<string, ValorHistorico>,
      salvo_em: agora.toISOString(),
      origem: "site",
    };
  });
}
