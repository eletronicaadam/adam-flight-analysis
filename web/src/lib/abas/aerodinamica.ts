/**
 * aerodinamica.ts — cálculos da aba Aerodinâmica (porta de
 * visualization/abas/aerodinamica.py): vento, velocidade do ar, CL, fator
 * de carga, α estimado, Reynolds e velocidades de estol.
 */
import type { Log, Mensagem } from "../dataflash";
import { col, filtrarInstancia, max, mediana, percentil } from "../tabela";
import { montarPainelPersonalizado, segundos, type LinhaPainel, type Painel } from "../dadosVoo";
import { gradiente } from "../numerico";
import type { Ficha } from "../ficha";
import { atitudeConfiavel } from "../analise/atitude";
import { analisar, densidadeAr, estimarVento, gpsEmMovimento, velocidadeEstol, type Vento } from "../analise/aerodinamica";

export const CL_MAX_REFERENCIA = [1.2, 1.4, 1.6, 1.8, 2.0];

export interface ParametrosAero {
  massa: number;
  area: number;
  envergadura: number;
  temperatura: number;
  /** null = liga só se a estimativa de vento for confiável (padrão do Streamlit). */
  usarVento: boolean | null;
}

/** Vento estimado com o avião em velocidade quase constante (hipótese do método). */
function vento(origem: number, gps: Mensagem): Vento | null {
  const t = segundos(gps, origem);
  const vel = col(gps, "Spd");
  const acel = t.length > 2 ? gradiente(vel, t) : new Float64Array(t.length);
  const v: number[] = [], r: number[] = [];
  const rumo = col(gps, "GCrs");
  for (let i = 0; i < t.length; i++) if (vel[i] > 5 && Math.abs(acel[i]) < 1.0) { v.push(vel[i]); r.push(rumo[i]); }
  return v.length < 10 ? null : estimarVento(v, r);
}

export interface ResultadoAero {
  rho: number;
  pressao: number;
  vento: Vento | null;
  usouVento: boolean;
  fonte_atitude: string;
  painel: Painel;
  dispersao: { cl: number[]; alfa: number[]; vel_ar: number[]; potencia: number[]; n: number[]; t: number[] };
  resumo: Record<string, number | null>;
  estol: { cl_max: number; nivelado: number; curva30: number; curva45: number }[];
  carga_alar: number;
}

export function prepararAero(dados: Log, origem: number, ficha: Ficha, inicio: number, fim: number,
                             p: ParametrosAero): ResultadoAero | null {
  const gps = gpsEmMovimento(dados, origem, inicio, fim);
  if (!gps) return null;
  // Densidade: pressão mediana do barômetro no trecho + temperatura do ar informada.
  let pressao = 101325.0;
  const b0 = dados.BARO;
  if (b0 && b0.n && b0.num.Press) {
    const baro = filtrarInstancia(b0, "I");
    const tb = segundos(baro, origem), press = col(baro, "Press");
    const dentro = Array.from(press).filter((_, i) => tb[i] >= inicio && tb[i] <= fim);
    pressao = dentro.length ? mediana(dentro) : mediana(press);
  }
  const rho = densidadeAr(pressao, p.temperatura);
  const v = vento(origem, gps);
  const usouVento = p.usarVento ?? !!(v && v.confiavel);
  const [atitude, fonteAtitude] = atitudeConfiavel(dados, ficha, origem, inicio, fim);
  const bat = dados.BAT ? filtrarInstancia(dados.BAT, "Inst") : null;
  const r = analisar(gps, origem, p.massa, p.area, p.envergadura, rho, usouVento ? v : null, atitude, bat);

  const linhas: LinhaPainel[] = [
    { titulo: "Velocidade (m/s)", series: [
      { t: r.t, y: r.vel_solo, nome: "Velocidade solo (GPS)", unidade: "m/s", casas: 1, cor: "#1f77b4" },
      { t: r.t, y: r.vel_ar, nome: "Velocidade do ar (estimada)", unidade: "m/s", casas: 1, cor: "#17becf" }] },
    { titulo: "Coef. de sustentação CL", series: [{ t: r.t, y: r.cl, nome: "CL em voo", casas: 2, cor: "#2ca02c" }] },
    { titulo: "Ângulo de ataque estim. (°)", series: [
      { t: r.t, y: r.alfa, nome: "α estimado", unidade: "°", casas: 1, cor: "#d62728" },
      { t: r.t, y: r.gama, nome: "Trajetória γ", unidade: "°", casas: 1, cor: "#9467bd" }] },
    { titulo: "Fator de carga n (g)", series: [{ t: r.t, y: r.fator_carga, nome: "Fator de carga", unidade: "g", casas: 2, cor: "#8c564b" }] },
    { titulo: "Potência elétrica (W)", series: [{ t: r.t, y: r.potencia, nome: "Potência", unidade: "W", casas: 0, cor: "#ff7f0e" }] },
  ];
  const painel = montarPainelPersonalizado(dados, origem, inicio, fim, linhas, true);

  const voando = r.voando;
  const emVoo = (x: Float64Array) => Array.from(x).filter((y, i) => voando[i] && Number.isFinite(y));
  const med = (x: Float64Array) => { const y = emVoo(x); return y.length ? mediana(y) : null; };
  const algum = voando.some(Boolean);
  const va = emVoo(r.vel_ar);
  const nOuNull = (x: number) => (Number.isFinite(x) ? x : null);
  const resumo = {
    cl_mediano: med(r.cl),
    cl_p95: algum ? nOuNull(percentil(emVoo(r.cl), 95)) : null,
    alfa_mediano: med(r.alfa),
    n_max: algum ? nOuNull(max(emVoo(r.fator_carga))) : null,
    re_mediano: med(r.reynolds),
    va_min: va.length ? percentil(va, 2) : null,
    va_mediana: va.length ? mediana(va) : null,
    corda: r.corda_m,
  };
  const dispersao = { cl: [] as number[], alfa: [] as number[], vel_ar: [] as number[], potencia: [] as number[], n: [] as number[], t: [] as number[] };
  for (let i = 0; i < r.t.length; i++) {
    if (!voando[i]) continue;
    dispersao.cl.push(r.cl[i]); dispersao.alfa.push(r.alfa[i]); dispersao.vel_ar.push(r.vel_ar[i]);
    dispersao.potencia.push(r.potencia[i]); dispersao.n.push(r.fator_carga[i]); dispersao.t.push(r.t[i]);
  }
  const estol = CL_MAX_REFERENCIA.map((clMax) => {
    const vs = velocidadeEstol(p.massa, p.area, rho, clMax);
    return { cl_max: clMax, nivelado: vs, curva30: vs * Math.sqrt(1 / Math.cos(Math.PI / 6)), curva45: vs * Math.sqrt(1 / Math.cos(Math.PI / 4)) };
  });
  return { rho, pressao, vento: v, usouVento, fonte_atitude: fonteAtitude, painel, dispersao, resumo, estol, carga_alar: p.massa / p.area };
}
