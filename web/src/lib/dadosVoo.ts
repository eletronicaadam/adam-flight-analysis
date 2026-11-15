/**
 * dadosVoo.ts — porta de visualization/dados_voo.py: recorte do trecho,
 * redução de pontos e montagem do pacote do painel interativo (mapa +
 * gráficos). Todo tempo é medido em segundos desde a primeira mensagem
 * do log, a mesma base para todos os sensores.
 */
import {
  col, filtrar, filtrarInstancia, interp, mascara, max, mediana, min, percentil, tem,
  type Log, type Mensagem,
} from "./tabela";

export const TIPOS_DO_PAINEL = ["GPS", "BAT", "BARO", "ARSP", "VIBE", "MODE"];
const GPS_FIX_MINIMO = 3;
const LACUNA_MAXIMA_S = 3.0;
const SALTO_IMPOSSIVEL_US = 600 * 1_000_000;
const SOLO_ANTES_DA_DECOLAGEM_S = 60.0;
export const DIVERGENCIA_ALTITUDE_M = 5.0;
export const VELOCIDADE_EM_VOO_MS = 3.0;

const MODOS_PLANE: Record<number, string> = {
  0: "MANUAL", 1: "CIRCLE", 2: "STABILIZE", 3: "TRAINING", 4: "ACRO",
  5: "FBWA", 6: "FBWB", 7: "CRUISE", 8: "AUTOTUNE", 10: "AUTO", 11: "RTL",
  12: "LOITER", 13: "TAKEOFF", 14: "AVOID_ADSB", 15: "GUIDED",
  17: "QSTABILIZE", 18: "QHOVER", 19: "QLOITER", 20: "QLAND", 21: "QRTL",
  22: "QAUTOTUNE", 23: "QACRO", 24: "THERMAL", 25: "LOITER_ALT_QLAND",
  26: "AUTOLAND",
};
const MODOS_COPTER: Record<number, string> = {
  0: "STABILIZE", 1: "ACRO", 2: "ALT_HOLD", 3: "AUTO", 4: "GUIDED",
  5: "LOITER", 6: "RTL", 7: "CIRCLE", 9: "LAND", 11: "DRIFT", 13: "SPORT",
  14: "FLIP", 15: "AUTOTUNE", 16: "POSHOLD", 17: "BRAKE", 18: "THROW",
  19: "AVOID_ADSB", 20: "GUIDED_NOGPS", 21: "SMART_RTL", 22: "FLOWHOLD",
  23: "FOLLOW", 24: "ZIGZAG", 25: "SYSTEMID", 26: "AUTOROTATE",
  27: "AUTO_RTL", 28: "TURTLE",
};
const MODOS_ROVER: Record<number, string> = {
  0: "MANUAL", 1: "ACRO", 3: "STEERING", 4: "HOLD", 5: "LOITER",
  6: "FOLLOW", 7: "SIMPLE", 8: "DOCK", 9: "CIRCLE", 10: "AUTO", 11: "RTL",
  12: "SMART_RTL", 15: "GUIDED",
};

// ---------------------------------------------------------------------
// Base de tempo e recorte
// ---------------------------------------------------------------------
/** TimeUS sem registros corrompidos isolados (saltos impossíveis dos dois lados). */
function temposConfiaveis(m: Mensagem): { min: number; max: number } | null {
  const t = m.num.TimeUS;
  const n = t.length;
  if (n === 0) return null;
  const salto = (i: number) => Math.abs(t[i + 1] - t[i]) > SALTO_IMPOSSIVEL_US;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    let isolado = false;
    if (n >= 3) {
      if (i === 0) isolado = salto(0);
      else if (i === n - 1) isolado = salto(n - 2);
      else isolado = salto(i - 1) && salto(i);
    }
    if (isolado) continue;
    if (t[i] < lo) lo = t[i];
    if (t[i] > hi) hi = t[i];
  }
  return lo <= hi ? { min: lo, max: hi } : null;
}

export function limitesUs(dados: Log): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const m of Object.values(dados)) {
    if (!m.num.TimeUS || !m.n) continue;
    const l = temposConfiaveis(m);
    if (!l) continue;
    lo = Math.min(lo, l.min);
    hi = Math.max(hi, l.max);
  }
  if (!Number.isFinite(lo)) {
    throw new Error(
      "O log não tem mensagens com TimeUS (logs muito antigos, de firmware anterior ao 3.3, " +
      "usam TimeMS e não são suportados).",
    );
  }
  return [lo, hi];
}

export const origemUs = (dados: Log) => limitesUs(dados)[0];
export const duracaoS = (dados: Log, origem: number) => (limitesUs(dados)[1] - origem) / 1e6;

export function segundos(m: Mensagem, origem: number): Float64Array {
  const t = m.num.TimeUS;
  const r = new Float64Array(m.n);
  for (let i = 0; i < m.n; i++) r[i] = (t[i] - origem) / 1e6;
  return r;
}

export function cortarJanela(dados: Log, inicio: number, fim: number, origem: number,
                             tipos: string[] = TIPOS_DO_PAINEL): Log {
  const janela: Log = {};
  for (const tipo of tipos) {
    const m = dados[tipo];
    if (!m || !m.num.TimeUS) continue;
    const t = segundos(m, origem);
    const r = filtrar(m, mascara(m, (i) => t[i] >= inicio && t[i] <= fim));
    if (r.n) janela[tipo] = r;
  }
  return janela;
}

/** GPS principal (instância 0) só com fix 3D ou melhor e posição válida. */
export function gpsValido(dados: Log): Mensagem | null {
  const g0 = dados.GPS;
  if (!g0 || !g0.n) return null;
  const g = filtrarInstancia(g0, "I");
  const st = col(g, "Status"), lat = col(g, "Lat"), lng = col(g, "Lng");
  const r = filtrar(g, mascara(g, (i) => st[i] >= GPS_FIX_MINIMO && lat[i] !== 0 && lng[i] !== 0));
  return r.n ? r : null;
}

export function detectarTrechoEmVoo(dados: Log, origem: number, margem = 10.0): [number, number] | null {
  const tempos: number[] = [];
  const gps = gpsValido(dados);
  if (gps) {
    const t = segundos(gps, origem), v = col(gps, "Spd");
    for (let i = 0; i < gps.n; i++) if (v[i] > VELOCIDADE_EM_VOO_MS) tempos.push(t[i]);
  }
  const a0 = dados.ARSP;
  if (a0 && tem(a0, "Airspeed")) {
    const a = filtrarInstancia(a0, "I");
    const t = segundos(a, origem), v = col(a, "Airspeed");
    for (let i = 0; i < a.n; i++) if (v[i] > VELOCIDADE_EM_VOO_MS) tempos.push(t[i]);
  }
  if (tempos.length < 2) return null;
  const total = duracaoS(dados, origem);
  let lo = Infinity, hi = -Infinity;
  for (const t of tempos) { if (t < lo) lo = t; if (t > hi) hi = t; }
  return [Math.max(0, lo - margem), Math.min(total, hi + margem)];
}

// ---------------------------------------------------------------------
// Redução de pontos
// ---------------------------------------------------------------------
/** Até ~maxPontos índices preservando picos (mín. e máx. de cada bloco). */
export function indicesReduzidos(v: ArrayLike<number>, maxPontos: number): Int32Array {
  const n = v.length;
  if (n <= maxPontos) return Int32Array.from({ length: n }, (_, i) => i);
  const blocos = Math.max(1, Math.floor(maxPontos / 2));
  const passo = n / blocos; // igual ao np.linspace(0, n, blocos + 1)
  const lim = (k: number) => (k === blocos ? n : Math.trunc(k * passo));
  const esc = new Set<number>();
  for (let k = 0; k < blocos; k++) {
    const a = lim(k), b = lim(k + 1);
    if (b <= a) continue;
    let iMin = a, iMax = a, vMin = Infinity, vMax = -Infinity;
    let primeiroMin = true, primeiroMax = true;
    for (let i = a; i < b; i++) {
      const x = v[i];
      const xMin = Number.isNaN(x) ? Infinity : x;
      const xMax = Number.isNaN(x) ? -Infinity : x;
      if (primeiroMin || xMin < vMin) { vMin = xMin; iMin = i; primeiroMin = false; }
      if (primeiroMax || xMax > vMax) { vMax = xMax; iMax = i; primeiroMax = false; }
    }
    esc.add(iMin);
    esc.add(iMax);
  }
  esc.add(n - 1);
  return Int32Array.from(esc).sort();
}

/** np.round(x, casas): arredonda o meio para o par. */
export function arredondar(x: number, casas: number): number {
  const f = 10 ** casas;
  const y = x * f;
  let r = Math.round(y);
  if (Math.abs(y % 1) === 0.5) r = 2 * Math.round(y / 2);
  return r / f;
}

export type ListaJson = (number | null)[];

export function lista(v: ArrayLike<number>, casas: number): ListaJson {
  const r: ListaJson = new Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const x = arredondar(v[i], casas);
    r[i] = Number.isFinite(x) ? x : null;
  }
  return r;
}

/**
 * Amostras `idx` de cada coluna, com um ponto vazio (NaN) no meio de cada
 * falha real do log (intervalo maior que o normal desta mensagem).
 */
export function amostrar(t: Float64Array, idx: Int32Array, colunas: Record<string, ArrayLike<number>>) {
  const intervalos = new Float64Array(Math.max(0, t.length - 1));
  for (let i = 1; i < t.length; i++) intervalos[i - 1] = t[i] - t[i - 1];
  const tipico = intervalos.length ? mediana(intervalos) : 0;
  const limite = Math.max(LACUNA_MAXIMA_S, 3 * tipico);
  const lacunas = new Set<number>();
  for (let i = 0; i < intervalos.length; i++) if (intervalos[i] > limite) lacunas.add(i);
  if (lacunas.size) {
    const s = new Set<number>(idx);
    for (const l of lacunas) { s.add(l); s.add(l + 1); }
    idx = Int32Array.from(s).sort();
  }
  const tSel: number[] = [];
  const sel: Record<string, number[]> = {};
  for (const nome of Object.keys(colunas)) sel[nome] = [];
  for (let k = 0; k < idx.length; k++) {
    // Falha entre a amostra anterior e esta: insere o ponto vazio.
    if (k > 0 && lacunas.has(idx[k - 1]) && idx[k] === idx[k - 1] + 1) {
      tSel.push((t[idx[k - 1]] + t[idx[k]]) / 2);
      for (const nome of Object.keys(colunas)) sel[nome].push(NaN);
    }
    tSel.push(t[idx[k]]);
    for (const [nome, v] of Object.entries(colunas)) sel[nome].push(v[idx[k]]);
  }
  return { tSel, sel };
}

export interface Serie {
  nome: string;
  unidade: string;
  t: ListaJson;
  y: ListaJson;
}

export function serie(t: Float64Array, y: ArrayLike<number>, nome: string, unidade: string,
               maxPontos: number, casas = 3): Serie | null {
  let algum = false;
  for (let i = 0; i < y.length; i++) if (Number.isFinite(y[i])) { algum = true; break; }
  if (!y.length || !algum) return null;
  const { tSel, sel } = amostrar(t, indicesReduzidos(y, maxPontos), { y });
  return { nome, unidade, t: lista(tSel, 3), y: lista(sel.y, casas) };
}

// ---------------------------------------------------------------------
// Modos de voo
// ---------------------------------------------------------------------
export function tipoDeVeiculo(dados: Log): string | null {
  const msg = dados.MSG;
  if (!msg || !msg.txt.Message) return null;
  const texto = msg.txt.Message.slice(0, 50).join(" ");
  for (const nome of ["ArduPlane", "ArduCopter", "ArduRover", "ArduSub", "Blimp", "AntennaTracker"]) {
    if (texto.includes(nome)) return nome;
  }
  return null;
}

export function nomeDoModo(valor: number | string, veiculo: string | null): string {
  if (typeof valor === "string") return valor;
  const tabela = veiculo === "ArduPlane" ? MODOS_PLANE : veiculo === "ArduCopter" ? MODOS_COPTER
    : veiculo === "ArduRover" ? MODOS_ROVER : {};
  const numero = Math.trunc(valor);
  return tabela[numero] ?? `Modo ${numero}`;
}

export interface Modo { t: number; nome: string }

export function modosNaJanela(dados: Log, origem: number, inicio: number, fim: number,
                              veiculo: string | null): Modo[] {
  const modo = dados.MODE;
  if (!modo || !modo.n) return [];
  const coluna = tem(modo, "ModeNum") ? "ModeNum" : "Mode";
  const t = segundos(modo, origem);
  const valores: (number | string)[] = modo.num[coluna] ? Array.from(modo.num[coluna]) : modo.txt[coluna];
  const r: Modo[] = [];
  let anterior = -1;
  for (let i = 0; i < modo.n; i++) if (t[i] <= inicio) anterior = i;
  if (anterior >= 0) r.push({ t: inicio, nome: nomeDoModo(valores[anterior], veiculo) });
  for (let i = 0; i < modo.n; i++) {
    if (t[i] > inicio && t[i] <= fim) r.push({ t: arredondar(t[i], 3), nome: nomeDoModo(valores[i], veiculo) });
  }
  return r;
}

// ---------------------------------------------------------------------
// Altitude: referência de solo e divergência barômetro × GPS
// ---------------------------------------------------------------------
export function instanteDecolagem(dados: Log, origem: number): number | null {
  const gps = gpsValido(dados);
  if (!gps) return null;
  const t = segundos(gps, origem), v = col(gps, "Spd");
  for (let i = 0; i < gps.n; i++) if (v[i] > VELOCIDADE_EM_VOO_MS) return t[i];
  return null;
}

export interface Referencias { BARO: number | null; GPS: number | null }

/** Altitude do solo de cada fonte: mediana das leituras paradas antes da decolagem. */
export function referenciasAltitude(dados: Log, origem: number): Referencias {
  const decolagem = instanteDecolagem(dados, origem);
  const noSolo = (m: Mensagem): Mensagem => {
    if (decolagem === null) return m;
    const t = segundos(m, origem);
    const perto = mascara(m, (i) => t[i] >= decolagem - SOLO_ANTES_DA_DECOLAGEM_S && t[i] <= decolagem - 2.0);
    if (perto.some((x) => x)) return filtrar(m, perto);
    const antes = mascara(m, (i) => t[i] < decolagem);
    if (antes.some((x) => x)) return filtrar(m, antes);
    let tMin = Infinity;
    for (const x of t) if (x < tMin) tMin = x;
    return filtrar(m, mascara(m, (i) => t[i] <= tMin + 5.0));
  };
  const refs: Referencias = { BARO: null, GPS: null };
  const b0 = dados.BARO;
  if (b0 && b0.n) {
    const b = filtrarInstancia(b0, "I");
    if (b.n) refs.BARO = mediana(col(noSolo(b), "Alt"));
  }
  let gps = gpsValido(dados);
  if (gps) {
    const spd = col(gps, "Spd");
    const parado = filtrar(gps, mascara(gps, (i) => spd[i] < 1.0));
    gps = parado.n ? parado : gps;
    if (tem(gps, "HDop")) {
      const h = col(gps, "HDop");
      const preciso = filtrar(gps, mascara(gps, (i) => h[i] <= 2.0));
      gps = preciso.n ? preciso : gps;
    }
    refs.GPS = mediana(col(noSolo(gps), "Alt"));
  }
  return refs;
}

export function divergenciaAltitude(janela: Log, origem: number, refs: Referencias) {
  const g0 = gpsValido(janela);
  const b0 = janela.BARO;
  if (!g0 || !b0 || refs.BARO === null || refs.GPS === null) return null;
  const baro = filtrarInstancia(b0, "I");
  const s = col(g0, "Spd");
  const gps = filtrar(g0, mascara(g0, (i) => s[i] > VELOCIDADE_EM_VOO_MS));
  if (gps.n < 5 || baro.n < 2) return null;
  const tGps = segundos(gps, origem);
  const refB = refs.BARO, refG = refs.GPS;
  const altBaro = interp(tGps, segundos(baro, origem), col(baro, "Alt").map((a) => a - refB));
  const altGps = col(gps, "Alt");
  const dif = altBaro.map((a, i) => Math.abs(a - (altGps[i] - refG)));
  let iMax = 0;
  for (let i = 1; i < dif.length; i++) if (dif[i] > dif[iMax]) iMax = i;
  return { max_m: dif[iMax], p95_m: percentil(dif, 95), t: tGps[iMax] };
}

export function altitudeMaxima(dados: Log, janela: Log, origem: number): Referencias {
  const refs = referenciasAltitude(dados, origem);
  const r: Referencias = { BARO: null, GPS: null };
  if (refs.BARO !== null && janela.BARO) {
    const alt = col(filtrarInstancia(janela.BARO, "I"), "Alt");
    if (alt.length) r.BARO = max(alt) - refs.BARO;
  }
  const gps = gpsValido(janela);
  if (refs.GPS !== null && gps) r.GPS = max(col(gps, "Alt")) - refs.GPS;
  return r;
}

// ---------------------------------------------------------------------
// Pacote do painel
// ---------------------------------------------------------------------
export interface Trajeto {
  t: ListaJson; lat: ListaJson; lng: ListaJson; alt: ListaJson; vel: ListaJson; rumo: ListaJson | null;
}

export interface Painel {
  id?: string;
  arquivo?: string;
  inicio: number;
  fim: number;
  veiculo: string | null;
  series: Record<string, Serie>;
  trajeto: Trajeto | null;
  modos: Modo[];
  avisos: string[];
  [extra: string]: unknown;
}

const mmss = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};

export function montarPainel(dados: Log, origem: number, inicio: number, fim: number,
                             maxPontos = 4000, maxPontosMapa = 3000): Painel {
  const janela = cortarJanela(dados, inicio, fim, origem);
  const veiculo = tipoDeVeiculo(dados);
  const series: Record<string, Serie> = {};
  const add = (chave: string, s: Serie | null) => { if (s) series[chave] = s; };

  const gpsTodo = gpsValido(dados);
  const gps = gpsValido(janela);
  if (gps) add("vel_solo", serie(segundos(gps, origem), col(gps, "Spd"), "Velocidade solo (GPS)", "m/s", maxPontos));
  if (janela.ARSP && tem(janela.ARSP, "Airspeed")) {
    const a = filtrarInstancia(janela.ARSP, "I");
    add("vel_ar", serie(segundos(a, origem), col(a, "Airspeed"), "Velocidade do ar", "m/s", maxPontos));
  }

  const refs = referenciasAltitude(dados, origem);
  const baro = janela.BARO ? filtrarInstancia(janela.BARO, "I") : null;
  if (baro && baro.n && refs.BARO !== null) {
    const r = refs.BARO;
    add("altitude", serie(segundos(baro, origem), col(baro, "Alt").map((a) => a - r),
      "Altitude (barômetro)", "m", maxPontos, 2));
  }
  if (gps && refs.GPS !== null) {
    const r = refs.GPS;
    add("altitude_gps", serie(segundos(gps, origem), col(gps, "Alt").map((a) => a - r),
      "Altitude (GPS)", "m", maxPontos, 2));
  }
  const avisos: string[] = [];
  const div = divergenciaAltitude(janela, origem, refs);
  if (div && div.p95_m > DIVERGENCIA_ALTITUDE_M) {
    avisos.push(
      `Barômetro e GPS discordam durante o voo: até ${div.max_m.toFixed(0)} m (aos ${mmss(div.t)}). ` +
      "Barômetro sem proteção costuma ser afetado pelo fluxo de ar e pela hélice (saltos rápidos, que " +
      "acompanham o pitch); o GPS tem erro vertical de alguns metros, mas varia de forma suave. Compare " +
      "as duas linhas no gráfico de altitude.",
    );
  }

  const bat = janela.BAT ? filtrarInstancia(janela.BAT, "Inst") : null;
  if (bat && bat.n) {
    const tBat = segundos(bat, origem);
    const tensao = col(bat, "Volt");
    add("tensao", serie(tBat, tensao, "Tensão", "V", maxPontos));
    const corrente = bat.num.Curr;
    if (corrente && corrente.some((c) => Number.isFinite(c))) {
      const potencia = tensao.map((v, i) => v * corrente[i]);
      const consumo = new Float64Array(bat.n);
      for (let i = 1; i < bat.n; i++) {
        const termo = ((corrente[i] + corrente[i - 1]) / 2) * (tBat[i] - tBat[i - 1]);
        consumo[i] = consumo[i - 1] + (Number.isFinite(termo) ? termo : 0);
      }
      add("corrente", serie(tBat, corrente, "Corrente", "A", maxPontos));
      add("potencia", serie(tBat, potencia, "Potência", "W", maxPontos, 1));
      add("consumo", serie(tBat, consumo.map((c) => c / 3.6), "Consumo no trecho", "mAh", maxPontos, 1));
    }
  }

  return {
    inicio: arredondar(inicio, 3),
    fim: arredondar(fim, 3),
    veiculo,
    series,
    trajeto: trajeto(gps, gpsTodo, origem, refs, maxPontosMapa),
    modos: modosNaJanela(dados, origem, inicio, fim, veiculo),
    avisos,
  };
}

export function trajeto(gps: Mensagem | null, gpsTodo: Mensagem | null, origem: number, refs: Referencias,
                 maxPontosMapa: number): Trajeto | null {
  if (!gps) return null;
  const passo = Math.max(1, Math.ceil(gps.n / maxPontosMapa));
  const s = new Set<number>();
  for (let i = 0; i < gps.n; i += passo) s.add(i);
  s.add(gps.n - 1);
  const idx = Int32Array.from(s).sort();
  const ref = refs.GPS !== null ? refs.GPS : col(gpsTodo!, "Alt")[0];
  const colunas: Record<string, ArrayLike<number>> = {
    lat: col(gps, "Lat"), lng: col(gps, "Lng"), alt: col(gps, "Alt").map((a) => a - ref), vel: col(gps, "Spd"),
  };
  if (gps.num.GCrs) colunas.rumo = gps.num.GCrs;
  const { tSel, sel } = amostrar(segundos(gps, origem), idx, colunas);
  return {
    t: lista(tSel, 3),
    lat: lista(sel.lat, 7),
    lng: lista(sel.lng, 7),
    alt: lista(sel.alt, 1),
    vel: lista(sel.vel, 2),
    rumo: sel.rumo ? lista(sel.rumo, 1) : null,
  };
}

const escaparXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Trajeto GPS do trecho em KML (Google Earth / My Maps), ou null sem GPS. */
export function gerarKml(dados: Log, origem: number, inicio: number, fim: number, nome: string): string | null {
  const gps = gpsValido(cortarJanela(dados, inicio, fim, origem, ["GPS"]));
  if (!gps) return null;
  const lat = col(gps, "Lat"), lng = col(gps, "Lng"), alt = col(gps, "Alt");
  const coords: string[] = [];
  for (let i = 0; i < gps.n; i++) coords.push(`${lng[i].toFixed(7)},${lat[i].toFixed(7)},${alt[i].toFixed(1)}`);
  const n = escaparXml(nome);
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${n}</name>
  <Style id="trajeto"><LineStyle><color>ff00a5ff</color><width>3</width></LineStyle></Style>
  <Placemark>
    <name>${n}</name>
    <styleUrl>#trajeto</styleUrl>
    <LineString>
      <altitudeMode>absolute</altitudeMode>
      <coordinates>${coords.join(" ")}</coordinates>
    </LineString>
  </Placemark>
</Document>
</kml>
`;
}

// ---------------------------------------------------------------------
// Painel personalizado (abas)
// ---------------------------------------------------------------------
/** Colunas que identificam a instância do sensor em cada tipo de mensagem. */
const COLUNAS_INSTANCIA = ["I", "Inst", "Instance", "IMU", "C"];
const MAX_INSTANCIAS = 16;

/**
 * Coluna de instância do sensor, ou null. Só vale coluna inteira com
 * valores pequenos: em PIDR/PIDP, "I" é o termo integral (float).
 */
export function colunaDeInstancia(m: Mensagem, campo?: string): string | null {
  for (const c of COLUNAS_INSTANCIA) {
    if (!(c in m.num) || c === campo || !m.inteiros.includes(c)) continue;
    if (m.n && (min(m.num[c]) < 0 || max(m.num[c]) >= MAX_INSTANCIAS)) continue;
    return c;
  }
  return null;
}

/** Formatos que o DFReader já escala (aplicar o fator do FMTU de novo daria valor errado). */
const FORMATOS_JA_ESCALADOS = new Set("cCeEL");
const UNIDADES_LEGIVEIS: Record<string, string> = {
  "m/s/s": "m/s²", deg: "°", deglatitude: "°", deglongitude: "°", degheading: "°",
  degC: "°C", "W.h": "Wh", satellites: "", "rad/s/s": "rad/s²", instance: "", "-": "",
  "#": "", UNKNOWN: "", gauss: "G", Pa: "Pa", "%": "%",
};

export type Unidades = Record<string, Record<string, [string, number]>>;

/** Unidade e fator de escala de cada campo, lidos de FMTU/UNIT/MULT do próprio log. */
export function unidades(dados: Log): Unidades {
  const fmtu = dados.FMTU, unit = dados.UNIT, mult = dados.MULT, fmt = dados.FMT;
  if (!fmtu || !unit || !fmt) return {};
  const rotulos = new Map<number, string>();
  for (let i = 0; i < unit.n; i++) rotulos.set(Math.trunc(col(unit, "Id")[i]), unit.txt.Label[i]);
  const fatores = new Map<number, number>();
  if (mult) for (let i = 0; i < mult.n; i++) fatores.set(Math.trunc(col(mult, "Id")[i]), col(mult, "Mult")[i]);
  const porTipo = new Map<number, { nome: string; colunas: string; formato: string }>();
  for (let i = 0; i < fmt.n; i++) {
    porTipo.set(col(fmt, "Type")[i], { nome: fmt.txt.Name[i], colunas: fmt.txt.Columns[i], formato: fmt.txt.Format[i] });
  }
  const ultimas = new Map<number, number>();
  for (let i = 0; i < fmtu.n; i++) ultimas.set(Math.trunc(col(fmtu, "FmtType")[i]), i);
  const r: Unidades = {};
  for (const [tipo, i] of ultimas) {
    const def = porTipo.get(tipo);
    if (!def) continue;
    const idsUnidade = fmtu.txt.UnitIds[i], idsMult = fmtu.txt.MultIds[i];
    const campos: Record<string, [string, number]> = {};
    def.colunas.split(",").forEach((campo, k) => {
      const rotulo = k < idsUnidade.length ? rotulos.get(idsUnidade.charCodeAt(k)) ?? "" : "";
      let fator = k < idsMult.length ? fatores.get(idsMult.charCodeAt(k)) ?? 1.0 : 1.0;
      if ((k < def.formato.length && FORMATOS_JA_ESCALADOS.has(def.formato[k])) || fator === 0 || fator === 1 || campo === "TimeUS") {
        fator = 1.0;
      }
      // O log guarda o fator em float32 (0.1 vira 0.100000001): arredonda.
      campos[campo] = [UNIDADES_LEGIVEIS[rotulo] ?? rotulo, Number(fator.toPrecision(6))];
    });
    r[def.nome] = campos;
  }
  return r;
}

/** (t, y) de um campo do log no trecho, só da instância pedida (y × fator). */
export function serieDoLog(dados: Log, origem: number, tipo: string, campo: string, inicio: number, fim: number,
                           instancia: number | null = 0, fator = 1.0): [Float64Array, Float64Array] | null {
  const m = dados[tipo];
  if (!m || !(campo in m.num) || !m.num.TimeUS) return null;
  const t = segundos(m, origem);
  const c = colunaDeInstancia(m, campo);
  const inst = c !== null && instancia !== null ? m.num[c] : null;
  const y = m.num[campo];
  const tt: number[] = [], yy: number[] = [];
  for (let i = 0; i < m.n; i++) {
    if (t[i] >= inicio && t[i] <= fim && (!inst || inst[i] === instancia)) { tt.push(t[i]); yy.push(fator !== 1 ? y[i] * fator : y[i]); }
  }
  return [Float64Array.from(tt), Float64Array.from(yy)];
}

export interface SpecSerie {
  nome: string;
  unidade?: string;
  casas?: number;
  cor?: string;
  tracejado?: boolean;
  cartao?: boolean;
  tipo?: string;
  campo?: string;
  instancia?: number | null;
  fator?: number;
  t?: ArrayLike<number>;
  y?: ArrayLike<number>;
}

export interface LinhaPainel { titulo: string; series: SpecSerie[] }

/** Pacote do painel com gráficos escolhidos pela aba (montar_painel_personalizado). */
export function montarPainelPersonalizado(dados: Log, origem: number, inicio: number, fim: number, linhas: LinhaPainel[],
                                          mostrarMapa = false, maxPontos = 4000, maxPontosMapa = 3000): Painel {
  const series: Record<string, Serie> = {};
  const linhasSaida: { titulo: string; series: string[] }[] = [];
  const cartoes: Record<string, unknown>[] = [{ chave: "tempo", nome: "Tempo" }];
  const cores: Record<string, string> = {};
  const tracejadas: string[] = [];
  let contador = 0;
  for (const linha of linhas) {
    const chaves: string[] = [];
    for (const spec of linha.series) {
      let par: [ArrayLike<number>, ArrayLike<number>] | null;
      if (spec.t) {
        const t: number[] = [], y: number[] = [];
        for (let i = 0; i < spec.t.length; i++) if (spec.t[i] >= inicio && spec.t[i] <= fim) { t.push(spec.t[i]); y.push(spec.y![i]); }
        par = [t, y];
      } else {
        par = serieDoLog(dados, origem, spec.tipo!, spec.campo!, inicio, fim, spec.instancia === undefined ? 0 : spec.instancia,
          spec.fator ?? 1.0);
      }
      if (!par) continue;
      const casas = spec.casas ?? 3;
      const s = serie(Float64Array.from(par[0]), par[1], spec.nome, spec.unidade ?? "", maxPontos, casas);
      if (!s) continue;
      const chave = `s${contador++}`;
      series[chave] = s;
      chaves.push(chave);
      // Linhas de referência (limites) não viram cartão de valor.
      if (spec.cartao ?? true) cartoes.push({ chave, nome: spec.nome, unidade: spec.unidade ?? "", casas: casas <= 3 ? casas : 2 });
      if (spec.tracejado) tracejadas.push(chave);
      if (spec.cor) cores[chave] = spec.cor;
    }
    if (chaves.length) linhasSaida.push({ titulo: linha.titulo, series: chaves });
  }
  let traj: Trajeto | null = null;
  if (mostrarMapa) {
    const janela = cortarJanela(dados, inicio, fim, origem, ["GPS"]);
    traj = trajeto(gpsValido(janela), gpsValido(dados), origem, referenciasAltitude(dados, origem), maxPontosMapa);
  }
  const veiculo = tipoDeVeiculo(dados);
  return {
    inicio: arredondar(inicio, 3),
    fim: arredondar(fim, 3),
    veiculo,
    series,
    linhas: linhasSaida,
    cartoes,
    cores,
    tracejadas,
    mostrar_mapa: mostrarMapa,
    trajeto: traj,
    modos: dados.MODE ? modosNaJanela(dados, origem, inicio, fim, veiculo) : [],
    avisos: [],
  };
}
