/**
 * tabela.ts — operações de "DataFrame" sobre as mensagens do log, com a
 * mesma semântica do pandas/numpy usada no Python (NaN é ignorado em
 * média/máximo/mediana, etc.).
 */
import { TAMANHO_ARRAY, type Log, type Mensagem } from "./dataflash";

export const tem = (m: Mensagem | undefined, col: string): boolean =>
  !!m && (col in m.num || col in m.txt);

export function col(m: Mensagem, nome: string): Float64Array {
  const c = m.num[nome];
  if (!c) throw new Error(`Coluna ${m.nome}.${nome} não existe neste log.`);
  return c;
}

/** Nova mensagem só com as linhas em que `manter[i]` é verdadeiro. */
export function filtrar(m: Mensagem, manter: ArrayLike<boolean | number>): Mensagem {
  let n = 0;
  for (let i = 0; i < m.n; i++) if (manter[i]) n++;
  if (n === m.n) return m;
  const num: Record<string, Float64Array> = {};
  const txt: Record<string, string[]> = {};
  for (const [c, v] of Object.entries(m.num)) {
    const novo = new Float64Array(n);
    let k = 0;
    for (let i = 0; i < m.n; i++) if (manter[i]) novo[k++] = v[i];
    num[c] = novo;
  }
  for (const [c, v] of Object.entries(m.txt)) {
    const novo: string[] = [];
    for (let i = 0; i < m.n; i++) if (manter[i]) novo.push(v[i]);
    txt[c] = novo;
  }
  let arr: Record<string, Int16Array> | undefined;
  for (const [c, v] of Object.entries(m.arr ?? {})) {
    const novo = new Int16Array(n * TAMANHO_ARRAY);
    let k = 0;
    for (let i = 0; i < m.n; i++) {
      if (manter[i]) novo.set(v.subarray(i * TAMANHO_ARRAY, (i + 1) * TAMANHO_ARRAY), TAMANHO_ARRAY * k++);
    }
    (arr ??= {})[c] = novo;
  }
  return { nome: m.nome, n, ordem: m.ordem, num, txt, inteiros: m.inteiros, ...(arr ? { arr } : {}) };
}

export function mascara(m: Mensagem, cond: (i: number) => boolean): Uint8Array {
  const r = new Uint8Array(m.n);
  for (let i = 0; i < m.n; i++) r[i] = cond(i) ? 1 : 0;
  return r;
}

/**
 * Só as linhas de uma instância do sensor (utils.filtrar_instancia). Se o
 * log não tem a coluna, devolve a mensagem inteira.
 */
export function filtrarInstancia(m: Mensagem, coluna: string, instancia = 0): Mensagem {
  const c = m.num[coluna];
  if (!c) return m;
  return filtrar(m, mascara(m, (i) => c[i] === instancia));
}

// ---------------------------------------------------------------------
// Estatísticas (ignorando NaN, como o pandas)
// ---------------------------------------------------------------------
export function max(v: ArrayLike<number>): number {
  let r = -Infinity, achou = false;
  for (let i = 0; i < v.length; i++) if (!Number.isNaN(v[i])) { if (v[i] > r) r = v[i]; achou = true; }
  return achou ? r : NaN;
}

export function min(v: ArrayLike<number>): number {
  let r = Infinity, achou = false;
  for (let i = 0; i < v.length; i++) if (!Number.isNaN(v[i])) { if (v[i] < r) r = v[i]; achou = true; }
  return achou ? r : NaN;
}

export function media(v: ArrayLike<number>): number {
  let s = 0, n = 0;
  for (let i = 0; i < v.length; i++) if (!Number.isNaN(v[i])) { s += v[i]; n++; }
  return n ? s / n : NaN;
}

function ordenadosSemNaN(v: ArrayLike<number>): Float64Array {
  const a: number[] = [];
  for (let i = 0; i < v.length; i++) if (!Number.isNaN(v[i])) a.push(v[i]);
  return Float64Array.from(a).sort();
}

export function mediana(v: ArrayLike<number>): number {
  const a = ordenadosSemNaN(v);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** np.percentile (interpolação linear). */
export function percentil(v: ArrayLike<number>, p: number): number {
  const a = ordenadosSemNaN(v);
  if (!a.length) return NaN;
  const pos = ((a.length - 1) * p) / 100;
  const i = Math.floor(pos);
  const f = pos - i;
  return i + 1 < a.length ? a[i] + (a[i + 1] - a[i]) * f : a[i];
}

/** np.trapezoid(y, x). */
export function trapezio(y: ArrayLike<number>, x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 1; i < y.length; i++) s += ((y[i] + y[i - 1]) / 2) * (x[i] - x[i - 1]);
  return s;
}

/** np.interp(x, xp, fp): xp crescente, fora do intervalo usa as pontas. */
export function interp(x: ArrayLike<number>, xp: ArrayLike<number>, fp: ArrayLike<number>): Float64Array {
  const r = new Float64Array(x.length);
  const n = xp.length;
  let j = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    if (xi <= xp[0]) { r[i] = fp[0]; continue; }
    if (xi >= xp[n - 1]) { r[i] = fp[n - 1]; continue; }
    // x quase sempre crescente: avança o ponteiro; senão, busca binária.
    if (j >= n - 1 || xp[j] > xi) {
      let a = 0, b = n - 1;
      while (b - a > 1) { const m = (a + b) >> 1; if (xp[m] <= xi) a = m; else b = m; }
      j = a;
    }
    while (j < n - 2 && xp[j + 1] <= xi) j++;
    const dx = xp[j + 1] - xp[j];
    r[i] = dx === 0 ? fp[j] : fp[j] + ((fp[j + 1] - fp[j]) * (xi - xp[j])) / dx;
  }
  return r;
}

export function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

export function distanciaPercorrida(lat: ArrayLike<number>, lng: ArrayLike<number>): number {
  let s = 0;
  for (let i = 1; i < lat.length; i++) s += haversine(lat[i - 1], lng[i - 1], lat[i], lng[i]);
  return s;
}

/** Tempo (s) de cada linha em relação à primeira (utils.tempo_em_segundos). */
export function tempoRelativo(m: Mensagem): Float64Array {
  const t = col(m, "TimeUS");
  const r = new Float64Array(m.n);
  for (let i = 0; i < m.n; i++) r[i] = (t[i] - t[0]) / 1e6;
  return r;
}

export function mapear(v: ArrayLike<number>, f: (x: number, i: number) => number): Float64Array {
  const r = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) r[i] = f(v[i], i);
  return r;
}

export type { Log, Mensagem };
