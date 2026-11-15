/**
 * sessao.ts — um log aberto e as consultas que as abas fazem a ele
 * (equivale a carregar_log + preparar_trecho do dashboard Streamlit).
 * Roda dentro do Web Worker: os dados do log nunca vão para a tela,
 * só os pacotes já reduzidos de cada trecho.
 */
import type { Log } from "./dataflash";
import { resumirVoo, type Resumo } from "./analise/resumo";
import type { Ficha } from "./ficha";
import { gerarDossie, type Dossie } from "./analise/dossie";
import { registrosDoLog, type RegistroVoo } from "./historico";
import { csvEventos, csvResumo, csvsDoTrecho, dadosRelatorio, eventosDoTrecho, veredito, type DadosRelatorio } from "./relatorio";
import { zipar } from "./zip";
import { detectar, type ResultadoEventos } from "./analise/eventos";
import { lotesBatchSampler, type Lote } from "./analise/espectro";
import { mensagensDoTrecho, prepararSaude } from "./abas/saude";
import { prepararVibracao } from "./abas/vibracao";
import { prepararAero, type ParametrosAero } from "./abas/aerodinamica";
import { barometroRuim, eventosParaReplay, prepararReplay } from "./abas/replay";
import {
  csvDoTrecho, opcoes, painelExplorador, parametrosOrdenados, rotulo, tabelaDoTrecho, type Agrupamento,
} from "./abas/explorador";
import {
  unidades, type Unidades,
  TIPOS_DO_PAINEL, altitudeMaxima, cortarJanela, detectarTrechoEmVoo, duracaoS, gerarKml, montarPainel,
  origemUs, tipoDeVeiculo, type Painel,
} from "./dadosVoo";

export interface InfoLog {
  nome: string;
  tamanho: number;
  duracao: number;
  trechoEmVoo: [number, number] | null;
  veiculo: string | null;
  tipos: Record<string, number>;
}

export interface ResultadoVoo {
  painel: Painel;
  resumo: Resumo;
  kml: string | null;
}

export class Sessao {
  readonly completo: Log;
  readonly dados: Log; // só os tipos da aba principal
  readonly origem: number;
  readonly info: InfoLog;

  constructor(log: Log, nome: string, tamanho: number) {
    this.completo = log;
    this.dados = {};
    for (const t of [...TIPOS_DO_PAINEL, "MSG"]) if (log[t]) this.dados[t] = log[t];
    // Origem do log completo: a mesma base de tempo para todas as abas.
    this.origem = origemUs(log);
    const tipos: Record<string, number> = {};
    for (const [k, m] of Object.entries(log)) tipos[k] = m.n;
    this.info = {
      nome,
      tamanho,
      duracao: duracaoS(this.dados, this.origem),
      trechoEmVoo: detectarTrechoEmVoo(this.dados, this.origem),
      veiculo: tipoDeVeiculo(log),
      tipos,
    };
  }

  voo(inicio: number, fim: number): ResultadoVoo {
    const janela = cortarJanela(this.dados, inicio, fim, this.origem);
    const resumo = resumirVoo(janela);
    // As análises medem a altitude a partir do início do trecho; para não
    // contradizer o painel, usa a mesma referência dele (solo).
    const altMax = altitudeMaxima(this.dados, janela, this.origem);
    const alt = resumo.altitude as Record<string, unknown> | undefined;
    const fonte = alt && alt.fonte === "BARO" ? "BARO" : "GPS";
    for (const [cat, f] of [["altitude", fonte], ["gps", "GPS"]] as const) {
      const r = resumo[cat] as Record<string, unknown> | undefined;
      const v = altMax[f];
      if (v !== null && r && "altitude_maxima_m" in r) r.altitude_maxima_m = v;
    }
    const painel = montarPainel(this.dados, this.origem, inicio, fim);
    painel.id = `voo|${this.info.nome}|${this.info.tamanho}|${inicio}|${fim}`;
    painel.arquivo = this.info.nome;
    const base = this.info.nome.replace(/\.bin$/i, "");
    const kml = gerarKml(this.dados, this.origem, inicio, fim, `${base} (${inicio.toFixed(0)}-${fim.toFixed(0)} s)`);
    return { painel, resumo, kml };
  }

  // ---- Abas que usam o log completo (calculado sob demanda, com cache) ----
  private _unidades?: Unidades;
  private _lotes?: Lote[];
  private _eventos?: { chave: string; r: ResultadoEventos };

  get unidades(): Unidades { return (this._unidades ??= unidades(this.completo)); }
  get lotes(): Lote[] { return (this._lotes ??= lotesBatchSampler(this.completo, this.origem)); }

  /** Eventos do log inteiro para a ficha dada (refeitos se a ficha mudar). */
  eventos(ficha: Ficha): ResultadoEventos {
    const chave = JSON.stringify(ficha);
    if (this._eventos?.chave !== chave) this._eventos = { chave, r: detectar(this.completo, ficha) };
    return this._eventos.r;
  }

  private comId<T extends { id?: string; arquivo?: string }>(p: T, aba: string, ...extra: unknown[]): T {
    p.id = [aba, this.info.nome, this.info.tamanho, ...extra].join("|");
    p.arquivo = this.info.nome;
    return p;
  }

  saude(inicio: number, fim: number) {
    const r = prepararSaude(this.completo, this.origem, this.unidades, inicio, fim);
    this.comId(r.painel, "saude", inicio, fim);
    return r;
  }

  vibracao(inicio: number, fim: number, fonte: "batch" | "imu") {
    const r = prepararVibracao(this.completo, this.origem, inicio, fim, this.lotes, fonte);
    if (r.painel) this.comId(r.painel, "vibracao", inicio, fim);
    return r;
  }

  aerodinamica(inicio: number, fim: number, ficha: Ficha, p: ParametrosAero) {
    const r = prepararAero(this.completo, this.origem, ficha, inicio, fim, p);
    if (r) this.comId(r.painel, "aero", inicio, fim, JSON.stringify(p), r.usouVento);
    return r;
  }

  replay(inicio: number, fim: number, ficha: Ficha, fonteAltura: "GPS" | "barômetro" | null) {
    const ruim = barometroRuim(this.completo, this.origem, inicio, fim);
    const fonte = fonteAltura ?? (ruim ? "GPS" : "barômetro");
    const payload = prepararReplay(this.completo, this.origem, ficha, inicio, fim, fonte,
      eventosParaReplay(this.eventos(ficha).eventos));
    payload.id = ["replay", this.info.nome, this.info.tamanho, inicio, fim, fonte].join("|");
    return { payload, barometroRuim: ruim, fonteAltura: fonte };
  }

  opcoesExplorador() {
    const o = opcoes(this.completo);
    return { ...o, rotulos: Object.fromEntries(o.opcoes.map((x) => [x, rotulo(x, this.unidades)])),
      temParametros: !!this.completo.PARM, temMensagens: !!this.completo.MSG };
  }

  explorador(inicio: number, fim: number, campos: string[], agrupamento: Agrupamento, instancia: number, mapa: boolean) {
    const p = painelExplorador(this.completo, this.origem, this.unidades, inicio, fim, campos, agrupamento, instancia, mapa);
    return this.comId(p, "explorador", inicio, fim, campos.join(","), agrupamento, instancia, mapa);
  }

  tabela(tipo: string, inicio: number, fim: number, instancia: number | null) {
    return tabelaDoTrecho(this.completo, this.origem, tipo, inicio, fim, instancia);
  }

  csv(tipo: string, inicio: number, fim: number, instancia: number | null) {
    return csvDoTrecho(this.completo, this.origem, tipo, inicio, fim, instancia);
  }

  parametros() { return parametrosOrdenados(this.completo); }

  mensagens(inicio: number, fim: number) { return mensagensDoTrecho(this.completo, this.origem, inicio, fim); }

  dossie(ficha: Ficha): Dossie { return gerarDossie(this.completo, ficha, this.info.nome); }

  relatorio(inicio: number, fim: number, ficha: Ficha): DadosRelatorio {
    return dadosRelatorio(this.completo, this.origem, inicio, fim, ficha, this.voo(inicio, fim), this.eventos(ficha),
      this.info.nome, this.info.tamanho, this.info.veiculo, this.info.duracao);
  }

  csvResumo(inicio: number, fim: number, ficha: Ficha): string {
    const v = veredito(eventosDoTrecho(this.eventos(ficha).eventos, inicio, fim));
    return csvResumo(this.info.nome, inicio, fim, this.voo(inicio, fim).resumo, v);
  }

  csvEventos(inicio: number, fim: number, ficha: Ficha): string {
    return csvEventos(eventosDoTrecho(this.eventos(ficha).eventos, inicio, fim));
  }

  /** Todas as mensagens do trecho, um CSV por tipo, num .zip. */
  zipTrecho(inicio: number, fim: number): Uint8Array {
    return zipar(csvsDoTrecho(this.completo, this.origem, inicio, fim));
  }

  historico(ficha: Ficha): RegistroVoo[] {
    return registrosDoLog(this.completo, this.eventos(ficha), this.info.nome, this.info.tamanho);
  }
}
