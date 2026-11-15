/**
 * aerodinamica.ts — porta de analysis/aerodinamica.py: estimativas para
 * aviões sem Pitot (só GPS): densidade do ar, vento, velocidade do ar,
 * fator de carga, CL em voo, Reynolds, ângulo de ataque e estol.
 */
import type { Log, Mensagem } from "../dataflash";
import { col, filtrar, filtrarInstancia, mascara, mediana } from "../tabela";
import { desvioPadrao, gradiente, graus, interpLR, mediaMovelSame, mediaSimples, modPy, pyRound, unwrap } from "../numerico";
import type { SerieAtitude } from "./atitude";

export const G = 9.80665;
const R_AR = 287.05;
const VISCOSIDADE_AR = 1.81e-5;

export const densidadeAr = (pressaoPa: number, temperaturaC: number) => pressaoPa / (R_AR * (temperaturaC + 273.15));

function mediaMovel(x: Float64Array, n: number): Float64Array {
  if (n <= 1 || x.length < n) return x;
  return mediaMovelSame(x, n);
}

export interface Vento {
  norte_ms: number; leste_ms: number; velocidade_ms: number; direcao_de_graus: number;
  velocidade_ar_media_ms: number; residuo_ms: number; cobertura_rumos_graus: number; confiavel: boolean;
}

/** np.arange(a, b, passo) com o mesmo número de pontos do numpy. */
function arange(a: number, b: number, passo: number): number[] {
  const n = Math.max(0, Math.ceil((b - a) / passo));
  return Array.from({ length: n }, (_, i) => a + i * passo);
}

/** Vento que torna a velocidade do ar mais constante (busca em grade grossa e fina). */
export function estimarVento(velSolo: ArrayLike<number>, rumoGraus: ArrayLike<number>, limite = 12.0): Vento | null {
  const v: number[] = [], r: number[] = [];
  for (let i = 0; i < velSolo.length; i++) {
    const rr = (rumoGraus[i] * Math.PI) / 180;
    if (Number.isFinite(velSolo[i]) && Number.isFinite(rr)) { v.push(velSolo[i]); r.push(rr); }
  }
  if (v.length < 10) return null;
  const vn = v.map((x, i) => x * Math.cos(r[i]));
  const ve = v.map((x, i) => x * Math.sin(r[i]));
  const va = new Float64Array(v.length);
  const custo = (wn: number, we: number) => {
    for (let i = 0; i < v.length; i++) va[i] = Math.hypot(vn[i] - wn, ve[i] - we);
    return desvioPadrao(va);
  };
  let melhor: [number, number, number] = [Infinity, 0, 0];
  for (const [passo, centro, raio] of [[0.5, [0, 0], limite], [0.05, null, 0.6]] as const) {
    const [cn, ce] = centro ?? [melhor[1], melhor[2]];
    for (const wn of arange(cn - raio, cn + raio + 1e-9, passo)) {
      for (const we of arange(ce - raio, ce + raio + 1e-9, passo)) {
        const c = custo(wn, we);
        if (c < melhor[0]) melhor = [c, wn, we];
      }
    }
  }
  const [residuo, wn, we] = melhor;
  const setores = new Set(r.map((x) => Math.floor(modPy(graus(x), 360) / 30)));
  for (let i = 0; i < v.length; i++) va[i] = Math.hypot(vn[i] - wn, ve[i] - we);
  return {
    norte_ms: wn, leste_ms: we,
    velocidade_ms: Math.hypot(wn, we),
    direcao_de_graus: modPy(graus(Math.atan2(we, wn)) + 180, 360),
    velocidade_ar_media_ms: mediaSimples(va),
    residuo_ms: residuo,
    cobertura_rumos_graus: setores.size * 30,
    confiavel: setores.size * 30 >= 270 && residuo < 1.5,
  };
}

export interface SeriesAero {
  t: Float64Array; vel_solo: Float64Array; vel_ar: Float64Array; fator_carga: Float64Array; cl: Float64Array;
  reynolds: Float64Array; alfa: Float64Array; gama: Float64Array; potencia: Float64Array; voando: Uint8Array;
  corda_m: number;
}

/** Séries aerodinâmicas nos instantes do GPS (instância 0, com fix, em movimento). */
export function analisar(gps: Mensagem, origem: number, massaKg: number, areaM2: number, envergaduraM: number,
                         rho: number, vento: Vento | null = null, atitude: SerieAtitude | null = null,
                         bat: Mensagem | null = null, velocidadeMin = 5.0): SeriesAero {
  const t = col(gps, "TimeUS").map((x) => (x - origem) / 1e6);
  const n = t.length;
  const vel = Float64Array.from(col(gps, "Spd"));
  const rumo = col(gps, "GCrs").map((g) => (g * Math.PI) / 180);
  const subida = gps.num.VZ ? gps.num.VZ.map((x) => -x) : new Float64Array(n);
  const vn = vel.map((v, i) => v * Math.cos(rumo[i]));
  const ve = vel.map((v, i) => v * Math.sin(rumo[i]));
  const va = vento ? vn.map((x, i) => Math.hypot(x - vento.norte_ms, ve[i] - vento.leste_ms)) : Float64Array.from(vel);

  let taxa = 1;
  if (n > 1) {
    const d = new Float64Array(n - 1);
    for (let i = 1; i < n; i++) d[i - 1] = t[i] - t[i - 1];
    taxa = 1 / Math.max(mediana(d), 1e-3);
  }
  const suav = Math.max(1, pyRound(taxa));
  const omega = n > 2 ? mediaMovel(gradiente(unwrap(rumo), t), suav) : new Float64Array(n);
  const acelVertical = n > 2 ? mediaMovel(gradiente(subida, t), suav) : new Float64Array(n);
  const fatorCarga = vel.map((v, i) => Math.hypot(v * omega[i], G + acelVertical[i]) / G);

  const voando = Uint8Array.from(va, (x) => (x > velocidadeMin ? 1 : 0));
  const corda = areaM2 / envergaduraM;
  const nan = (cond: number, x: number) => (cond ? x : NaN);
  const cl = va.map((x, i) => nan(voando[i], (fatorCarga[i] * massaKg * G) / (0.5 * rho * x * x * areaM2)));
  const reynolds = va.map((x, i) => nan(voando[i], (rho * x * corda) / VISCOSIDADE_AR));
  const gama = va.map((x, i) => graus(Math.asin(Math.max(-1, Math.min(1, subida[i] / Math.max(x, 0.1))))));
  let alfa = new Float64Array(n).fill(NaN);
  if (atitude && atitude.t.length) {
    const pitch = interpLR(t, atitude.t, atitude.Pitch);
    alfa = pitch.map((p, i) => nan(voando[i], p - gama[i]));
  }
  let potencia = new Float64Array(n).fill(NaN);
  if (bat && bat.n && bat.num.Curr) {
    const tb: number[] = [], p: number[] = [];
    const tBat = col(bat, "TimeUS"), volt = col(bat, "Volt"), curr = bat.num.Curr;
    for (let i = 0; i < bat.n; i++) {
      const x = volt[i] * curr[i];
      // Monitor só de tensão (Curr = NaN): potência fica "sem medição", não 0 W.
      if (Number.isFinite(x)) { tb.push((tBat[i] - origem) / 1e6); p.push(x); }
    }
    if (p.length) potencia = interpLR(t, tb, p);
  }
  return {
    t, vel_solo: vel, vel_ar: va.map((x, i) => nan(voando[i], x)), fator_carga: fatorCarga.map((x, i) => nan(voando[i], x)),
    cl, reynolds, alfa, gama: gama.map((x, i) => nan(voando[i], x)), potencia, voando, corda_m: corda,
  };
}

export const velocidadeEstol = (massaKg: number, areaM2: number, rho: number, clMax: number, fatorCarga = 1.0) =>
  Math.sqrt((2 * fatorCarga * massaKg * G) / (rho * areaM2 * clMax));

/** GPS instância 0, com fix, no trecho e acima de velocidadeMin (≥ 5 pontos). */
export function gpsEmMovimento(dados: Log, origem: number, inicio: number, fim: number, velocidadeMin = 3.0): Mensagem | null {
  const g0 = dados.GPS;
  if (!g0 || !g0.n || !g0.num.GCrs) return null;
  const g = filtrarInstancia(g0, "I");
  const tu = col(g, "TimeUS"), st = col(g, "Status"), spd = col(g, "Spd");
  const r = filtrar(g, mascara(g, (i) => {
    const t = (tu[i] - origem) / 1e6;
    return st[i] >= 3 && t >= inicio && t <= fim && spd[i] > velocidadeMin;
  }));
  return r.n >= 5 ? r : null;
}
