/**
 * vibracao.ts — cálculos da aba Vibração (porta de
 * visualization/abas/vibracao.py): níveis no tempo, comparação por fase
 * (motor parado / ligado no solo / em voo), espectro e espectrograma.
 */
import type { Log } from "../dataflash";
import { col, filtrarInstancia, max, min, percentil } from "../tabela";
import { montarPainelPersonalizado, segundos, type LinhaPainel, type Painel } from "../dadosVoo";
import { interpLR } from "../numerico";
import { detectarVoos } from "../analise/eventos";
import {
  amostrasImu, espectroBatch, espectrograma, espectroWelch, picos, type Lote,
} from "../analise/espectro";

export const ATENCAO = 30.0, CRITICO = 60.0;
export const FASES = ["Solo, motor parado", "Solo, motor ligado", "Em movimento / voo"] as const;

/** Fase de cada instante: motor parado, motor ligado no solo, em voo. */
function fases(dados: Log, origem: number, t: Float64Array): string[] {
  const fase = Array.from(t, () => FASES[0] as string);
  const bat0 = dados.BAT;
  if (bat0 && bat0.num.Curr) {
    const bat = filtrarInstancia(bat0, "Inst");
    const corrente = interpLR(t, segundos(bat, origem), col(bat, "Curr").map((c) => (Number.isNaN(c) ? 0 : c)));
    corrente.forEach((c, i) => { if (c > 3.0) fase[i] = FASES[1]; });
  }
  for (const voo of detectarVoos(dados, origem)) {
    t.forEach((x, i) => { if (x >= voo.inicio_s && x <= voo.fim_s) fase[i] = FASES[2]; });
  }
  return fase;
}

/** Estatísticas de caixa (como o box plot do Plotly: quartis lineares e bigodes de 1,5 × IQR). */
export interface Caixa { fase: string; n: number; q1: number; mediana: number; q3: number; min: number; max: number; inferior: number; superior: number }

function caixa(fase: string, v: number[]): Caixa {
  const q1 = percentil(v, 25), q3 = percentil(v, 75);
  const iqr = q3 - q1;
  const dentro = v.filter((x) => x >= q1 - 1.5 * iqr && x <= q3 + 1.5 * iqr);
  return { fase, n: v.length, q1, mediana: percentil(v, 50), q3, min: min(v), max: max(v), inferior: min(dentro), superior: max(dentro) };
}

export interface ResultadoVibracao {
  metricas: { p99: Record<string, number>; max: Record<string, number>; clip: number | null } | null;
  fases: Caixa[] | null;
  espectro: { freq: Float64Array; eixos: Float64Array[]; taxa: number; origem: string; picos: [number, number][] } | null;
  espectrograma: { t: Float64Array; freq: Float64Array; db: Float64Array[] } | null;
  painel: Painel | null;
  temBatch: boolean;
}

export function prepararVibracao(dados: Log, origem: number, inicio: number, fim: number, lotes: Lote[],
                                 fonte: "batch" | "imu"): ResultadoVibracao {
  const r: ResultadoVibracao = { metricas: null, fases: null, espectro: null, espectrograma: null, painel: null, temBatch: lotes.length > 0 };
  const vibe0 = dados.VIBE;
  if (vibe0 && vibe0.n) {
    const vibe = filtrarInstancia(vibe0, "IMU");
    const t = segundos(vibe, origem);
    const idx: number[] = [];
    for (let i = 0; i < vibe.n; i++) if (t[i] >= inicio && t[i] <= fim) idx.push(i);
    if (idx.length) {
      const eixos = ["VibeX", "VibeY", "VibeZ"].map((c) => idx.map((i) => col(vibe, c)[i]));
      const colunaClip = vibe.num.Clip ? "Clip" : vibe.num.Clip0 ? "Clip0" : null;
      const clip = colunaClip ? idx.map((i) => vibe.num[colunaClip][i]) : null;
      r.metricas = {
        p99: { VibeX: percentil(eixos[0], 99), VibeY: percentil(eixos[1], 99), VibeZ: percentil(eixos[2], 99) },
        max: { VibeX: max(eixos[0]), VibeY: max(eixos[1]), VibeZ: max(eixos[2]) },
        clip: clip ? Math.trunc(max(clip) - min(clip)) : null,
      };
      const fase = fases(dados, origem, Float64Array.from(idx, (i) => t[i]));
      const maior = idx.map((_, k) => max([eixos[0][k], eixos[1][k], eixos[2][k]]));
      r.fases = FASES.map((f) => maior.filter((_, k) => fase[k] === f && !Number.isNaN(maior[k])))
        .map((v, k) => (v.length ? caixa(FASES[k], v) : null)).filter((c): c is Caixa => c !== null);
    }
    const linhas: LinhaPainel[] = [
      { titulo: "Vibração (m/s²)", series: [
        ...["VibeX", "VibeY", "VibeZ"].map((c) => ({ tipo: "VIBE", campo: c, nome: c, unidade: "m/s²", casas: 1 })),
        { t: [inicio, fim], y: [ATENCAO, ATENCAO], nome: "atenção (30)", tracejado: true, cartao: false, cor: "#ffa421" },
        { t: [inicio, fim], y: [CRITICO, CRITICO], nome: "crítico (60)", tracejado: true, cartao: false, cor: "#ff4b4b" },
      ] },
    ];
    if (vibe.num.Clip) linhas.push({ titulo: "Clipping (contagem)", series: [{ tipo: "VIBE", campo: "Clip", nome: "Clipping", casas: 0 }] });
    linhas.push({ titulo: "Acelerômetro (m/s²)", series: ["AccX", "AccY", "AccZ"].map((c) =>
      ({ tipo: "IMU", campo: c, nome: c, unidade: "m/s²", casas: 2 })) });
    r.painel = montarPainelPersonalizado(dados, origem, inicio, fim, linhas, false);
  }

  if (fonte === "batch" && lotes.length) {
    const e = espectroBatch(lotes, inicio, fim);
    if (e) {
      r.espectro = { freq: e.freq, eixos: e.eixos, taxa: e.taxa, origem: `batch sampler (${e.lotes} lotes, ${e.taxa.toFixed(0)} Hz)`,
        picos: picos(e.freq, maiorPorFrequencia(e.eixos)) };
    }
  } else {
    const a = amostrasImu(dados, origem, inicio, fim);
    if (a) {
      const eixos: Float64Array[] = [];
      let freq = new Float64Array();
      for (let k = 0; k < 3; k++) {
        const [f, amp] = espectroWelch(a.acc[k], a.taxa);
        freq = f;
        eixos.push(amp);
      }
      r.espectro = { freq, eixos, taxa: a.taxa, origem: `mensagem IMU (${a.taxa.toFixed(0)} Hz)`, picos: picos(freq, maiorPorFrequencia(eixos)) };
      const g = espectrograma(a.t, a.acc[2], a.taxa);
      if (g.t.length) r.espectrograma = g;
    }
  }
  return r;
}

function maiorPorFrequencia(eixos: Float64Array[]): Float64Array {
  return eixos[0].map((_, k) => Math.max(...eixos.map((e) => e[k])));
}
