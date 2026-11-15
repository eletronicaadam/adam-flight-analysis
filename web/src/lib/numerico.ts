/**
 * numerico.ts — funções do numpy/Python usadas pelas análises, com a
 * mesma semântica (para os números saírem iguais aos do Python).
 */

/**
 * round(x, casas) do Python: arredonda pelo valor decimal exato do
 * double e, no empate exato, para o par (round(0.125, 2) = 0.12,
 * round(2.675, 2) = 2.67).
 */
export function pyRound(x: number, casas = 0): number {
  if (!Number.isFinite(x)) return x;
  const a = Math.abs(x);
  if (a >= 1e15) return x;
  const exato = a.toFixed(Math.min(100, casas + 40));
  const [inteira, frac] = exato.split(".");
  const resto = frac.slice(casas);
  let r: number;
  if (/^50*$/.test(resto)) {
    const digitos = inteira + frac.slice(0, casas);
    const par = Number(digitos[digitos.length - 1]) % 2 === 0;
    r = par ? Number(`${inteira}.${frac.slice(0, casas) || "0"}`) : Number(a.toFixed(casas));
  } else {
    r = Number(a.toFixed(casas));
  }
  return x < 0 ? -r : r;
}

/** Resto sempre positivo, como o % do Python com divisor positivo. */
export const modPy = (a: number, b: number) => ((a % b) + b) % b;

export const graus = (rad: number) => (rad * 180) / Math.PI;
export const radianos = (g: number) => (g * Math.PI) / 180;

/** np.gradient(f, x): diferenças centrais de 2ª ordem (espaçamento irregular), 1ª ordem nas pontas. */
export function gradiente(f: ArrayLike<number>, x: ArrayLike<number>): Float64Array {
  const n = f.length;
  const r = new Float64Array(n);
  if (n < 2) return r;
  r[0] = (f[1] - f[0]) / (x[1] - x[0]);
  r[n - 1] = (f[n - 1] - f[n - 2]) / (x[n - 1] - x[n - 2]);
  for (let i = 1; i < n - 1; i++) {
    const hs = x[i] - x[i - 1];
    const hd = x[i + 1] - x[i];
    r[i] = (hs * hs * f[i + 1] + (hd * hd - hs * hs) * f[i] - hd * hd * f[i - 1]) / (hs * hd * (hd + hs));
  }
  return r;
}

/** np.convolve(x, np.ones(n) / n, mode="same") (média móvel centrada). */
export function mediaMovelSame(x: ArrayLike<number>, n: number): Float64Array {
  const N = x.length;
  const tam = Math.max(N, n);
  const r = new Float64Array(tam);
  // saída "same" = convolução completa a partir de (n - 1) // 2
  const desloc = Math.floor((n - 1) / 2);
  if (N < n) {
    // numpy troca os papéis quando o núcleo é maior que o sinal
    const d2 = Math.floor((N - 1) / 2);
    for (let i = 0; i < tam; i++) {
      const j = i + d2;
      let s = 0;
      for (let m = Math.max(0, j - n + 1); m <= Math.min(N - 1, j); m++) s += x[m];
      r[i] = s / n;
    }
    return r;
  }
  for (let i = 0; i < N; i++) {
    const j = i + desloc;
    let s = 0;
    for (let m = Math.max(0, j - n + 1); m <= Math.min(N - 1, j); m++) s += x[m];
    r[i] = s / n;
  }
  return r;
}

/** np.interp(x, xp, fp, left, right): xp crescente. */
export function interpLR(x: ArrayLike<number>, xp: ArrayLike<number>, fp: ArrayLike<number>,
                         left?: number, right?: number): Float64Array {
  const r = new Float64Array(x.length);
  const n = xp.length;
  if (!n) return r.fill(NaN);
  const esq = left ?? fp[0];
  const dir = right ?? fp[n - 1];
  let j = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    if (Number.isNaN(xi)) { r[i] = NaN; continue; }
    if (xi < xp[0]) { r[i] = esq; continue; }
    if (xi > xp[n - 1]) { r[i] = dir; continue; }
    if (xi === xp[n - 1]) { r[i] = fp[n - 1]; continue; }
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

/** np.unwrap (período 2π). */
export function unwrap(p: ArrayLike<number>): Float64Array {
  const r = Float64Array.from(p);
  let soma = 0;
  for (let i = 1; i < r.length; i++) {
    const d = p[i] - p[i - 1];
    let dm = modPy(d + Math.PI, 2 * Math.PI) - Math.PI;
    if (dm === -Math.PI && d > 0) dm = Math.PI;
    const corr = Math.abs(d) < Math.PI ? 0 : dm - d;
    soma += corr;
    r[i] = p[i] + soma;
  }
  return r;
}

/** np.std (populacional), sem ignorar NaN. */
export function desvioPadrao(v: ArrayLike<number>): number {
  const n = v.length;
  if (!n) return NaN;
  let s = 0;
  for (let i = 0; i < n; i++) s += v[i];
  const m = s / n;
  let q = 0;
  for (let i = 0; i < n; i++) q += (v[i] - m) ** 2;
  return Math.sqrt(q / n);
}

/** np.mean sem ignorar NaN. */
export function mediaSimples(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i];
  return v.length ? s / v.length : NaN;
}

/** np.hanning(n). */
export function hanning(n: number): Float64Array {
  const r = new Float64Array(n);
  if (n === 1) { r[0] = 1; return r; }
  for (let i = 0; i < n; i++) r[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return r;
}

/** |np.fft.rfft(x)| para n potência de 2 (FFT radix-2). */
export function rfftAbs(x: ArrayLike<number>): Float64Array {
  const n = x.length;
  const re = Float64Array.from(x);
  const im = new Float64Array(n);
  // permutação bit-reversa
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; }
  }
  for (let tam = 2; tam <= n; tam <<= 1) {
    const ang = (-2 * Math.PI) / tam;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += tam) {
      let cr = 1, ci = 0;
      for (let k = 0; k < tam / 2; k++) {
        const a = i + k, b = a + tam / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  const r = new Float64Array((n >> 1) + 1);
  for (let k = 0; k < r.length; k++) r[k] = Math.hypot(re[k], im[k]);
  return r;
}

/** np.fft.rfftfreq(n, d). */
export function rfftfreq(n: number, d: number): Float64Array {
  const r = new Float64Array((n >> 1) + 1);
  for (let k = 0; k < r.length; k++) r[k] = k / (n * d);
  return r;
}

/** Índices em que a máscara é verdadeira (np.nonzero). */
export function indices(m: ArrayLike<boolean | number>): number[] {
  const r: number[] = [];
  for (let i = 0; i < m.length; i++) if (m[i]) r.push(i);
  return r;
}

export function soma(m: ArrayLike<boolean | number>): number {
  let s = 0;
  for (let i = 0; i < m.length; i++) s += Number(m[i]);
  return s;
}

export function algum(m: ArrayLike<boolean | number>): boolean {
  for (let i = 0; i < m.length; i++) if (m[i]) return true;
  return false;
}

/** Valores de `v` nos índices `idx` (ou onde a máscara é verdadeira). */
export function pegar(v: ArrayLike<number>, idx: ArrayLike<number>): Float64Array {
  const r = new Float64Array(idx.length);
  for (let i = 0; i < idx.length; i++) r[i] = v[idx[i]];
  return r;
}

export function onde(v: ArrayLike<number>, m: ArrayLike<boolean | number>): Float64Array {
  const r: number[] = [];
  for (let i = 0; i < v.length; i++) if (m[i]) r.push(v[i]);
  return Float64Array.from(r);
}

/**
 * f"{x:.Nf}" / f"{x:+.Nf}" do Python: arredonda como o Python (empate
 * para o par) e mantém o "-0".
 */
export function fmtPy(x: number, casas: number, sinal = false): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? (sinal ? "+inf" : "inf") : "-inf";
  let s = Math.abs(pyRound(x, casas)).toFixed(casas);
  const negativo = x < 0 || Object.is(x, -0);
  if (negativo) s = "-" + s;
  else if (sinal) s = "+" + s;
  return s;
}

/** mm:ss.s como o _mmss do Python (divmod e "{r:04.1f}"). */
export function mmssPy(s: number): string {
  const x = Math.max(0, s);
  const r = x % 60; // divmod do Python usa o fmod
  const m = Math.round((x - r) / 60);
  return `${m}:${fmtPy(r, 1).padStart(4, "0")}`;
}
