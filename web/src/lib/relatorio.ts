/**
 * relatorio.ts — dados do relatório PDF de um trecho (roda no worker) e
 * as exportações em CSV: resumo do trecho, eventos e todas as mensagens
 * do trecho (um CSV por tipo, como o exportar_mensagens_brutas do Python).
 */
import type { Log } from "./dataflash";
import type { Ficha } from "./ficha";
import { serie, serieDoLog, segundos, type Serie, type Trajeto } from "./dadosVoo";
import type { Resumo } from "./analise/resumo";
import { GRAVIDADES, type Evento, type Gravidade, type ResultadoEventos } from "./analise/eventos";
import { infoDoLog } from "./analise/dossie";
import { achatar, dataGps } from "./historico";
import { pyRound } from "./numerico";

export interface DadosRelatorio {
  arquivo: string;
  tamanho: number;
  veiculo: string | null;
  firmware: string | null;
  placa: string | null;
  duracaoLog: number;
  /** Data/hora UTC (ISO) do início do trecho pelo GPS. */
  data: string | null;
  trecho: [number, number];
  ficha: Ficha;
  resumo: Resumo;
  veredito: string;
  contagem: Record<Gravidade, number>;
  eventos: Evento[];
  qualidade: string[];
  avisos: string[];
  series: Record<string, Serie>;
  vibracao: Serie[];
  trajeto: Trajeto | null;
  fonteAtitude: string | null;
}

/** Eventos que se sobrepõem ao trecho (os sem instante valem para o log todo). */
export function eventosDoTrecho(eventos: Evento[], inicio: number, fim: number): Evento[] {
  return eventos.filter((e) => e.inicio_s === null || ((e.fim_s ?? e.inicio_s) >= inicio && e.inicio_s <= fim));
}

export function veredito(eventos: Evento[]) {
  const contagem = Object.fromEntries(GRAVIDADES.map((g) => [g, eventos.filter((e) => e.gravidade === g).length])) as
    Record<Gravidade, number>;
  return { contagem, veredito: contagem.critico ? "problemas críticos" : contagem.atencao ? "atenção" : "voo normal" };
}

export function dadosRelatorio(completo: Log, origem: number, inicio: number, fim: number, ficha: Ficha,
                               voo: { painel: { series: Record<string, Serie>; trajeto: Trajeto | null; avisos: string[] }; resumo: Resumo },
                               ev: ResultadoEventos, arquivo: string, tamanho: number, veiculo: string | null,
                               duracaoLog: number): DadosRelatorio {
  const doTrecho = eventosDoTrecho(ev.eventos, inicio, fim);
  const info = infoDoLog(completo, origem);
  const vibracao: Serie[] = [];
  for (const eixo of ["VibeX", "VibeY", "VibeZ"]) {
    const par = serieDoLog(completo, origem, "VIBE", eixo, inicio, fim, 0);
    const s = par && serie(par[0], par[1], eixo, "m/s²", 2000, 1);
    if (s) vibracao.push(s);
  }
  return {
    arquivo, tamanho, veiculo, firmware: info.firmware, placa: info.placa, duracaoLog, data: dataGps(completo, origem, inicio), trecho: [inicio, fim], ficha,
    resumo: voo.resumo, ...veredito(doTrecho), eventos: doTrecho, qualidade: ev.qualidade_dados,
    avisos: voo.painel.avisos, series: voo.painel.series, vibracao, trajeto: voo.painel.trajeto, fonteAtitude: ev.atitude.fonte,
  };
}

// ---------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------
const celula = (v: unknown): string => {
  if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const linhaCsv = (valores: unknown[]) => valores.map(celula).join(",");

/** Uma linha com o resumo do trecho, nas colunas do historico_voos.csv. */
export function csvResumo(arquivo: string, inicio: number, fim: number, resumo: Resumo, v: ReturnType<typeof veredito>): string {
  const metricas = achatar(resumo as Record<string, unknown>);
  const cab = ["arquivo", "inicio_s", "fim_s", "veredito", "eventos_critico", "eventos_atencao", "eventos_info", ...Object.keys(metricas)];
  const linha = [arquivo, inicio, fim, v.veredito, v.contagem.critico, v.contagem.atencao, v.contagem.info, ...Object.values(metricas)];
  return `${cab.join(",")}\n${linhaCsv(linha)}\n`;
}

/** Eventos (um por linha), com a evidência em JSON. */
export function csvEventos(eventos: Evento[]): string {
  const cab = ["inicio_s", "fim_s", "gravidade", "categoria", "codigo", "titulo", "descricao", "fonte", "confianca", "evidencia"];
  return [cab.join(","), ...eventos.map((e) => linhaCsv([e.inicio_s, e.fim_s, e.gravidade, e.categoria, e.codigo, e.titulo,
    e.descricao, e.fonte, e.confianca, e.evidencia]))].join("\n") + "\n";
}

/**
 * Todas as mensagens do trecho, um CSV por tipo (TimeUS como no log, mais
 * t_s em segundos desde o início do log). Tipos sem TimeUS (FMT, PARM
 * antigos...) entram inteiros.
 */
export function csvsDoTrecho(dados: Log, origem: number, inicio: number, fim: number): Record<string, string> {
  const r: Record<string, string> = {};
  for (const tipo of Object.keys(dados).sort()) {
    const m = dados[tipo];
    const t = m.num.TimeUS ? segundos(m, origem) : null;
    const colunas = m.ordem.filter((c) => c in m.num || c in m.txt);
    const linhas: string[] = [[...colunas, ...(t ? ["t_s"] : [])].join(",")];
    for (let i = 0; i < m.n; i++) {
      if (t && (t[i] < inicio || t[i] > fim)) continue;
      const v = colunas.map((c) => (c in m.num ? m.num[c][i] : m.txt[c][i]));
      if (t) v.push(pyRound(t[i], 6));
      linhas.push(linhaCsv(v));
    }
    if (linhas.length > 1) r[`${tipo}.csv`] = linhas.join("\n") + "\n";
  }
  return r;
}
