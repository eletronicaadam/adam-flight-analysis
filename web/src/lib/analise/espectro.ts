/**
 * espectro.ts — porta de analysis/espectro.py: espectro de vibração
 * (Welch), espectrograma e leitura do batch sampler do ArduPilot
 * (ISBH/ISBD, a IMU gravada em alta taxa).
 */
import { TAMANHO_ARRAY, type Log } from "../dataflash";
import { col, filtrarInstancia, mediana } from "../tabela";
import { hanning, rfftAbs, rfftfreq } from "../numerico";

const seg = (t: ArrayLike<number>, origem: number) => Float64Array.from(t, (x) => (x - origem) / 1e6);

export interface AmostrasImu { t: Float64Array; acc: Float64Array[]; gyr: Float64Array[]; taxa: number }

/** Amostras da mensagem IMU no trecho, ou null (menos de 16). */
export function amostrasImu(dados: Log, origem: number, inicio: number, fim: number, instancia = 0): AmostrasImu | null {
  const imu0 = dados.IMU;
  if (!imu0 || !imu0.n) return null;
  const imu = filtrarInstancia(imu0, "I", instancia);
  const tTodo = seg(col(imu, "TimeUS"), origem);
  const idx: number[] = [];
  for (let i = 0; i < imu.n; i++) if (tTodo[i] >= inicio && tTodo[i] <= fim) idx.push(i);
  if (idx.length < 16) return null;
  const pick = (c: string) => Float64Array.from(idx, (i) => col(imu, c)[i]);
  const t = Float64Array.from(idx, (i) => tTodo[i]);
  const dts = new Float64Array(t.length - 1);
  for (let i = 1; i < t.length; i++) dts[i - 1] = t[i] - t[i - 1];
  return {
    t,
    acc: ["AccX", "AccY", "AccZ"].map(pick),
    gyr: ["GyrX", "GyrY", "GyrZ"].map(pick),
    taxa: 1 / mediana(dts),
  };
}

/**
 * Espectro de amplitude (Welch: Hann, 50% de sobreposição, média
 * quadrática entre blocos). Uma senoide de 5 m/s² a 80 Hz vira um pico de
 * ~5 em 80 Hz.
 */
export function espectroWelch(x0: ArrayLike<number>, taxa: number, tamanho0 = 256): [Float64Array, Float64Array] {
  const x = Float64Array.from(x0).filter(Number.isFinite);
  if (x.length < 16) return [new Float64Array(), new Float64Array()];
  const tamanho = Math.min(tamanho0, 2 ** Math.trunc(Math.log2(x.length)));
  const passo = Math.floor(tamanho / 2);
  const janela = hanning(tamanho);
  let somaJanela = 0;
  for (const w of janela) somaJanela += w;
  const acum = new Float64Array(Math.floor(tamanho / 2) + 1);
  let blocos = 0;
  const b = new Float64Array(tamanho);
  for (let i = 0; i + tamanho <= x.length; i += passo) {
    let m = 0;
    for (let k = 0; k < tamanho; k++) m += x[i + k];
    m /= tamanho;
    for (let k = 0; k < tamanho; k++) b[k] = (x[i + k] - m) * janela[k];
    const amp = rfftAbs(b);
    for (let k = 0; k < acum.length; k++) acum[k] += ((2 * amp[k]) / somaJanela) ** 2;
    blocos++;
  }
  return [rfftfreq(tamanho, 1 / taxa), acum.map((s) => Math.sqrt(s / blocos))];
}

export interface Espectrograma { t: Float64Array; freq: Float64Array; db: Float64Array[] /* [freq][tempo] */ }

export function espectrograma(t: ArrayLike<number>, x: ArrayLike<number>, taxa: number, janelaS = 2.0): Espectrograma {
  const tamanho = 2 ** Math.max(4, Math.trunc(Math.log2(Math.max(16, janelaS * taxa))));
  const passo = Math.max(1, Math.floor(tamanho / 2));
  const janela = hanning(tamanho);
  const colunas: Float64Array[] = [];
  const centros: number[] = [];
  const b = new Float64Array(tamanho);
  for (let i = 0; i + tamanho <= x.length; i += passo) {
    let ok = true, m = 0;
    for (let k = 0; k < tamanho; k++) { if (!Number.isFinite(x[i + k])) { ok = false; break; } m += x[i + k]; }
    if (!ok) continue;
    m /= tamanho;
    for (let k = 0; k < tamanho; k++) b[k] = (x[i + k] - m) * janela[k];
    colunas.push(rfftAbs(b));
    centros.push(t[i + Math.floor(tamanho / 2)]);
  }
  if (!colunas.length) return { t: new Float64Array(), freq: new Float64Array(), db: [] };
  const nf = colunas[0].length;
  const db: Float64Array[] = [];
  for (let f = 0; f < nf; f++) db.push(Float64Array.from(colunas, (c) => 20 * Math.log10(Math.max(c[f], 1e-6))));
  return { t: Float64Array.from(centros), freq: rfftfreq(tamanho, 1 / taxa), db };
}

/** As maiores frequências de pico (máximos locais), ignorando abaixo de freqMin Hz. */
export function picos(freq: ArrayLike<number>, amplitude: ArrayLike<number>, quantidade = 3, freqMin = 2.0): [number, number][] {
  if (freq.length < 3) return [];
  const f: number[] = [], a: number[] = [];
  for (let i = 0; i < freq.length; i++) if (freq[i] >= freqMin) { f.push(freq[i]); a.push(amplitude[i]); }
  const maximos: number[] = [];
  for (let i = 1; i < a.length - 1; i++) if (a[i] >= a[i - 1] && a[i] >= a[i + 1]) maximos.push(i);
  maximos.sort((p, q) => a[q] - a[p]); // estável, como o sort do Python
  return maximos.slice(0, quantidade).map((i) => [f[i], a[i]]);
}

export interface Lote { sensor: "acelerometro" | "giroscopio"; instancia: number; t0: number; taxa: number; amostras: Float64Array[] /* 3 eixos */ }

/** Junta os lotes do batch sampler (ISBH = cabeçalho, ISBD = dados). */
export function lotesBatchSampler(dados: Log, origem: number): Lote[] {
  const isbh = dados.ISBH, isbd = dados.ISBD;
  if (!isbh || !isbd || !isbh.n || !isbd.n || !isbd.arr) return [];
  const nD = col(isbd, "N"), seq = col(isbd, "seqno");
  const porLote = new Map<number, number[]>();
  for (let i = 0; i < isbd.n; i++) {
    const l = porLote.get(nD[i]) ?? [];
    l.push(i);
    porLote.set(nD[i], l);
  }
  for (const l of porLote.values()) l.sort((a, b) => seq[a] - seq[b]);
  const nH = col(isbh, "N"), mul = col(isbh, "mul"), tipo = col(isbh, "type"), inst = col(isbh, "instance");
  const taxa = col(isbh, "smp_rate");
  const cnt = isbh.num.smp_cnt;
  const inicio = isbh.num.SampleUS ?? col(isbh, "TimeUS");
  const lotes: Lote[] = [];
  for (let h = 0; h < isbh.n; h++) {
    const linhas = porLote.get(nH[h]);
    if (!linhas || !linhas.length || !mul[h]) continue;
    const eixos = ["x", "y", "z"].map((c) => {
      const a = isbd.arr![c];
      const r = new Float64Array(linhas.length * TAMANHO_ARRAY);
      linhas.forEach((li, k) => { for (let j = 0; j < TAMANHO_ARRAY; j++) r[k * TAMANHO_ARRAY + j] = a[li * TAMANHO_ARRAY + j]; });
      return r;
    });
    let n = Math.min(...eixos.map((e) => e.length));
    if (cnt && cnt[h]) n = Math.min(n, Math.trunc(cnt[h]));
    lotes.push({
      sensor: Math.trunc(tipo[h]) === 0 ? "acelerometro" : "giroscopio",
      instancia: Math.trunc(inst[h]),
      t0: (inicio[h] - origem) / 1e6,
      taxa: taxa[h],
      amostras: eixos.map((e) => e.subarray(0, n).map((v) => v / mul[h])),
    });
  }
  return lotes;
}

export interface EspectroBatch { freq: Float64Array; eixos: Float64Array[]; taxa: number; lotes: number }

/** Espectro médio dos lotes do batch sampler dentro do trecho (por eixo). */
export function espectroBatch(lotes: Lote[], inicio: number, fim: number, sensor = "acelerometro",
                              instancia = 0): EspectroBatch | null {
  let esc = lotes.filter((l) => l.sensor === sensor && l.instancia === instancia && inicio <= l.t0 && l.t0 <= fim
    && l.amostras[0].length >= 64);
  if (!esc.length) return null;
  const taxa = esc[0].taxa;
  esc = esc.filter((l) => Math.abs(l.taxa - taxa) < 1);
  const menor = Math.min(...esc.map((l) => l.amostras[0].length));
  const tamanho = Math.min(512, 2 ** Math.floor(Math.log2(menor)));
  let freq = new Float64Array();
  const eixos: Float64Array[] = [];
  for (let e = 0; e < 3; e++) {
    const esp = esc.map((l) => espectroWelch(l.amostras[e], taxa, tamanho));
    const n = Math.min(...esp.map((x) => x[0].length));
    freq = esp[0][0].subarray(0, n);
    const m = new Float64Array(n);
    for (const x of esp) for (let k = 0; k < n; k++) m[k] += x[1][k] / esp.length;
    eixos.push(m);
  }
  return { freq, eixos, taxa, lotes: esc.length };
}
