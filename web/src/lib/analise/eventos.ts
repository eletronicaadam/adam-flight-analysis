/**
 * eventos.ts — porta de analysis/eventos.py: detecta eventos de
 * segurança (bateria, vibração, GPS, controle, atitude, mensagens do
 * firmware e falhas de configuração). Cada evento traz instante,
 * gravidade, evidência numérica e de onde veio.
 *
 * Todos os limites ficam em LIMITES, cada um com a sua fonte.
 */
import type { Log, Mensagem } from "../dataflash";
import { col, filtrar, filtrarInstancia, haversine, max, mediana, min, percentil } from "../tabela";
import { controladoraComanda, type Ficha } from "../ficha";
import {
  cortarJanela, divergenciaAltitude, gpsValido, origemUs, referenciasAltitude, segundos,
} from "../dadosVoo";
import { fmtPy, graus, interpLR, mediaSimples, mmssPy, pyRound } from "../numerico";
import { detectarOrientacao, parametro, reprocessarAtitude, type DeteccaoOrientacao, type SerieAtitude } from "./atitude";

export const LIMITES: Record<string, [number, string]> = {
  vibracao_atencao_ms2: [30.0, "ArduPilot: vibração acima de 30 m/s² prejudica a estimativa de posição/altitude"],
  vibracao_critica_ms2: [60.0, "ArduPilot: acima de 60 m/s² o estimador pode falhar"],
  vibracao_duracao_s: [1.0, "ignora picos isolados (toques, pouso)"],
  clip_aumento: [1, "ArduPilot: qualquer clipping em voo indica acelerômetro saturado"],
  celula_minima_v: [3.3, "ficha da aeronave (bateria.tensao_minima_celula_v)"],
  queda_celula_atencao_v: [0.6, "queda sob carga acima de ~0,6 V/célula indica bateria cansada ou subdimensionada"],
  corrente_duracao_s: [0.5, "corrente acima do limite por mais que isso"],
  hdop_max: [2.0, "HDop acima de 2 = precisão horizontal ruim"],
  satelites_min: [6, "menos de 6 satélites = posição pouco confiável"],
  gps_salto_ms: [60.0, "salto de posição mais rápido que isso é erro de GPS"],
  controle_erro_graus: [10.0, "atitude real longe da pedida pelo piloto automático"],
  controle_duracao_s: [1.0, "erro de controle sustentado"],
  roll_extremo_graus: [60.0, "inclinação lateral acima disso é manobra extrema para este tipo de avião"],
  pitch_extremo_graus: [30.0, "pitch acima de ±30° é atitude extrema"],
  angulo_ataque_alto_graus: [15.0, "pitch menos ângulo da trajetória acima disso: perto do estol na maioria dos perfis"],
  angulo_ataque_duracao_s: [2.0, "sustentado"],
  descida_ingreme_graus: [-15.0, "trajetória mais inclinada que isso para baixo"],
  descida_ingreme_duracao_s: [1.0, "sustentada"],
  impacto_desaceleracao_ms2: [5.0, "parada mais brusca que isso no fim do voo não é pouso normal"],
  divergencia_altitude_m: [5.0, "barômetro e GPS discordando mais que isso em voo"],
  velocidade_voo_ms: [3.0, "acima disso o avião está em movimento (corrida ou voo)"],
};

export const GRAVIDADES = ["critico", "atencao", "info"] as const;
export type Gravidade = (typeof GRAVIDADES)[number];

const lim = (nome: string) => LIMITES[nome][0];

export interface Evento {
  codigo: string;
  categoria: string;
  gravidade: Gravidade;
  inicio_s: number | null;
  fim_s: number | null;
  titulo: string;
  descricao: string;
  evidencia: Record<string, unknown>;
  fonte: string;
  confianca: string;
}

export interface Voo { inicio_s: number; fim_s: number; duracao_s: number; velocidade_max_ms: number }

function evento(lista: Evento[], codigo: string, categoria: string, gravidade: Gravidade, inicio: number | null | undefined,
                fim: number | null | undefined, titulo: string, descricao: string, evidencia: Record<string, unknown> = {},
                fonte = "", confianca = "alta") {
  lista.push({
    codigo, categoria, gravidade,
    inicio_s: inicio === null || inicio === undefined ? null : pyRound(inicio, 2),
    fim_s: fim === null || fim === undefined ? null : pyRound(fim, 2),
    titulo, descricao, evidencia, fonte, confianca,
  });
}

type Mascara = ArrayLike<boolean | number>;
type Intervalo = [number, number, number[]];

/** Trechos contínuos em que a máscara é verdadeira: [ini, fim, índices a..b]. */
function intervalos(t: ArrayLike<number>, m: Mascara, duracaoMin = 0.0, juntarS = 1.0): Intervalo[] {
  const idx: number[] = [];
  for (let i = 0; i < m.length; i++) if (m[i]) idx.push(i);
  if (!idx.length) return [];
  const trechos: [number, number][] = [];
  let comeco = idx[0], anterior = idx[0];
  for (const i of idx.slice(1)) {
    if (t[i] - t[anterior] > juntarS) { trechos.push([comeco, anterior]); comeco = i; }
    anterior = i;
  }
  trechos.push([comeco, anterior]);
  return trechos.filter(([a, b]) => t[b] - t[a] >= duracaoMin)
    .map(([a, b]) => [t[a], t[b], Array.from({ length: b - a + 1 }, (_, k) => a + k)]);
}

/** Instantes em voo, sem as janelas de impacto (se dadas). */
function emVoo(t: ArrayLike<number>, voos: Voo[], impactos: [number, number][] = []): Uint8Array {
  const r = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) {
    let v = false;
    for (const voo of voos) if (t[i] >= voo.inicio_s && t[i] <= voo.fim_s) v = true;
    for (const [ini, fim] of impactos) if (t[i] >= ini - 0.5 && t[i] <= fim + 1.0) v = false;
    r[i] = v ? 1 : 0;
  }
  return r;
}

const pick = (v: ArrayLike<number>, idx: number[]) => idx.map((i) => v[i]);
const algumEm = (m: Mascara, idx: number[]) => idx.some((i) => m[i]);
const qualquer = (m: Mascara) => { for (let i = 0; i < m.length; i++) if (m[i]) return true; return false; };
const qtd = (m: Mascara) => { let s = 0; for (let i = 0; i < m.length; i++) if (m[i]) s++; return s; };
const ondeM = (v: ArrayLike<number>, m: Mascara) => { const r: number[] = []; for (let i = 0; i < v.length; i++) if (m[i]) r.push(v[i]); return r; };
/** max do numpy (propaga NaN). */
const maxNp = (v: ArrayLike<number>) => { let r = -Infinity; for (let i = 0; i < v.length; i++) { if (Number.isNaN(v[i])) return NaN; if (v[i] > r) r = v[i]; } return r; };
const minNp = (v: ArrayLike<number>) => { let r = Infinity; for (let i = 0; i < v.length; i++) { if (Number.isNaN(v[i])) return NaN; if (v[i] < r) r = v[i]; } return r; };
const argmax = (v: ArrayLike<number>) => { let k = 0; for (let i = 1; i < v.length; i++) if (v[i] > v[k]) k = i; return k; };
const argmaxAbs = (v: number[]) => { let k = 0; for (let i = 1; i < v.length; i++) if (Math.abs(v[i]) > Math.abs(v[k])) k = i; return v[k]; };

// -----------------------------------------------------------------------
// Fases do voo
// -----------------------------------------------------------------------
/** Trechos em movimento (velocidade GPS acima do limite por pelo menos 3 s). */
export function detectarVoos(dados: Log, origem: number): Voo[] {
  const gps = gpsValido(dados);
  if (!gps) return [];
  const t = segundos(gps, origem);
  const vel = col(gps, "Spd");
  const rapido = Uint8Array.from(vel, (v) => (v > lim("velocidade_voo_ms") ? 1 : 0));
  const trechos: Intervalo[] = [];
  for (const [ini, fim, idx] of intervalos(t, rapido, 3.0, 3.0)) {
    // Nenhuma leitura de GPS válida entre dois trechos = perdeu o fix em voo: junta.
    const ultimo = trechos[trechos.length - 1];
    if (ultimo && !Array.prototype.some.call(t, (x: number) => x > ultimo[1] && x < ini)) {
      trechos[trechos.length - 1] = [ultimo[0], fim, [...ultimo[2], ...idx]];
    } else {
      trechos.push([ini, fim, idx]);
    }
  }
  return trechos.map(([ini, fim, idx]) => ({
    inicio_s: pyRound(ini, 2),
    fim_s: pyRound(fim, 2),
    duracao_s: pyRound(fim - ini, 1),
    velocidade_max_ms: pyRound(maxNp(pick(vel, idx)), 1),
  }));
}

function fimDoVoo(eventos: Evento[], dados: Log, origem: number, voo: Voo, atitude: SerieAtitude | null) {
  const gps = gpsValido(dados)!;
  const t = segundos(gps, origem);
  const vel = col(gps, "Spd");
  const tt: number[] = [], vv: number[] = [];
  for (let i = 0; i < gps.n; i++) if (t[i] >= voo.fim_s - 3 && t[i] <= voo.fim_s + 3) { tt.push(t[i]); vv.push(vel[i]); }
  if (tt.length < 3) return;
  const iMax = argmax(vv);
  let j = -1;
  for (let k = 0; k < tt.length; k++) if (tt[k] > tt[iMax] && vv[k] < 2.0) { j = k; break; }
  if (j < 0) return;
  const desaceleracao = (vv[iMax] - vv[j]) / Math.max(tt[j] - tt[iMax], 1e-3);
  const evid: Record<string, unknown> = {
    velocidade_antes_ms: pyRound(vv[iMax], 1),
    tempo_ate_parar_s: pyRound(tt[j] - tt[iMax], 2),
    desaceleracao_ms2: pyRound(desaceleracao, 1),
  };
  const bat0 = dados.BAT;
  if (bat0 && bat0.num.Curr) {
    const bat = filtrarInstancia(bat0, "Inst");
    const tb = segundos(bat, origem), curr = col(bat, "Curr");
    const janela = Array.from(tb, (x) => x >= tt[iMax] - 1 && x <= tt[j] + 1);
    const antes = Array.from(tb, (x) => x >= tt[iMax] - 5 && x < tt[iMax] - 1);
    if (qualquer(janela)) evid.pico_corrente_a = pyRound(max(ondeM(curr, janela)), 1);
    if (qualquer(antes)) evid.corrente_antes_a = pyRound(mediana(ondeM(curr, antes)), 1);
  }
  const imu0 = dados.IMU;
  if (imu0 && imu0.n) {
    const imu = filtrarInstancia(imu0, "I");
    const ti = segundos(imu, origem);
    const ax = col(imu, "AccX"), ay = col(imu, "AccY"), az = col(imu, "AccZ");
    const normas: number[] = [];
    for (let i = 0; i < imu.n; i++) if (ti[i] >= tt[iMax] - 1 && ti[i] <= tt[j] + 1) normas.push(Math.hypot(ax[i], ay[i], az[i]));
    if (normas.length) evid.pico_aceleracao_g = pyRound(maxNp(normas) / 9.81, 1);
  }
  if (atitude) {
    const p: number[] = [], r: number[] = [];
    for (let i = 0; i < atitude.t.length; i++) {
      if (atitude.t[i] > tt[j] + 1 && atitude.t[i] < tt[j] + 4) { p.push(atitude.Pitch[i]); r.push(atitude.Roll[i]); }
    }
    if (p.length) {
      evid.pitch_apos_parar_graus = pyRound(mediana(p), 0);
      evid.roll_apos_parar_graus = pyRound(mediana(r), 0);
    }
  }
  if (desaceleracao > lim("impacto_desaceleracao_ms2")) {
    evento(eventos, "impacto", "Fases do voo", "critico", tt[iMax], tt[j], "Fim abrupto do voo (provável impacto)",
      `A velocidade caiu de ${fmtPy(vv[iMax], 0)} m/s para quase zero em ${fmtPy(tt[j] - tt[iMax], 1)} s ` +
      `(${fmtPy(desaceleracao, 0)} m/s²) — muito mais brusco que um pouso.`, evid, "GPS.Spd, BAT.Curr, IMU");
  } else {
    evento(eventos, "pouso", "Fases do voo", "info", tt[iMax], tt[j], "Fim do voo / pouso",
      `Parada a partir de ${fmtPy(vv[iMax], 0)} m/s em ${fmtPy(tt[j] - tt[iMax], 1)} s.`, evid, "GPS.Spd");
  }
}

// -----------------------------------------------------------------------
// Detectores
// -----------------------------------------------------------------------
/** Resistência interna (Ω) no degrau de corrente antes da decolagem, ou null. */
function resistenciaInterna(t: Float64Array, volt: Float64Array, corr: Float64Array, inicioVoo: number): number | null {
  const tt: number[] = [], cc: number[] = [], vv: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] > inicioVoo - 30 && t[i] < inicioVoo + 10 && Number.isFinite(corr[i])) { tt.push(t[i]); cc.push(corr[i]); vv.push(volt[i]); }
  }
  if (tt.length < 10) return null;
  const alvo = 0.5 * percentil(cc, 95);
  const subida = cc.findIndex((c) => c > alvo);
  if (subida < 0 || alvo < 5) return null;
  const tDegrau = tt[subida];
  const antes = tt.map((x) => x > tDegrau - 3 && x < tDegrau - 0.5);
  const depois = tt.map((x) => x > tDegrau + 0.5 && x < tDegrau + 3);
  if (qtd(antes) < 2 || qtd(depois) < 2) return null;
  const deltaI = mediana(ondeM(cc, depois)) - mediana(ondeM(cc, antes));
  if (deltaI < 10) return null;
  return pyRound((mediana(ondeM(vv, antes)) - mediana(ondeM(vv, depois))) / deltaI, 3);
}

function bateria(eventos: Evento[], dados: Log, origem: number, ficha: Ficha, voos: Voo[],
                 impactos: [number, number][]): Record<string, unknown> {
  const bat0 = dados.BAT;
  if (!bat0 || !bat0.n) return {};
  const bat = filtrarInstancia(bat0, "Inst");
  if (!bat.n) return {};
  const t = segundos(bat, origem);
  const volt = col(bat, "Volt");
  const corr = bat.num.Curr ?? new Float64Array(t.length).fill(NaN);

  let celulas = ficha.bateria.celulas;
  let origemCelulas = "ficha";
  if (!celulas) {
    celulas = Math.max(1, pyRound(max(volt) / 4.2));
    origemCelulas = "estimado pela tensão máxima";
  }
  const c = celulas;
  const info: Record<string, unknown> = { celulas: c, celulas_fonte: origemCelulas };
  const voando0 = emVoo(t, voos);

  const minimo = ficha.bateria.tensao_minima_celula_v || lim("celula_minima_v");
  for (const [ini, fim, idx] of intervalos(t, Array.from(volt, (v) => v / c < minimo), 1.0)) {
    const vMin = min(pick(volt, idx));
    evento(eventos, "bateria_celula_baixa", "Bateria", algumEm(voando0, idx) ? "critico" : "atencao", ini, fim,
      `Tensão abaixo de ${fmtPy(minimo, 2)} V por célula`,
      `Mínimo de ${fmtPy(vMin / c, 2)} V/célula (${fmtPy(vMin, 2)} V, ${c}S).`,
      { tensao_min_v: pyRound(vMin, 2), celulas: c }, "BAT.Volt");
  }

  if (voos.length && qualquer(Array.from(corr, Number.isFinite))) {
    const primeiro = voos[0].inicio_s;
    const repouso = Array.from(t, (x, i) => x > primeiro - 30 && x < primeiro - 2 && (Number.isNaN(corr[i]) ? 0 : corr[i]) < 3);
    // Sem o instante do impacto (pico de corrente da hélice batendo).
    const ev = emVoo(t, voos, impactos);
    const voando = Array.from(t, (_, i) => !!ev[i] && Number.isFinite(corr[i]));
    if (qtd(repouso) >= 3 && qtd(voando) >= 10) {
      const vRep = mediana(ondeM(volt, repouso));
      // Tensão sob carga sustentada: percentil 2 (ignora picos isolados).
      const vMin = percentil(ondeM(volt, voando), 2);
      const queda = (vRep - vMin) / c;
      const corrMedia = mediaSimples(ondeM(corr, voando));
      Object.assign(info, {
        tensao_repouso_v: pyRound(vRep, 2), tensao_min_voo_v: pyRound(vMin, 2),
        queda_por_celula_v: pyRound(queda, 2),
        corrente_media_voo_a: pyRound(corrMedia, 1),
        resistencia_interna_ohm: resistenciaInterna(t, volt, corr, voos[0].inicio_s),
      });
      const gravidade = queda > lim("queda_celula_atencao_v") ? "atencao" : "info";
      const iv = voando.flatMap((v, i) => (v ? [i] : []));
      let iMin = iv[0];
      for (const i of iv) if (Math.abs(volt[i] - vMin) < Math.abs(volt[iMin] - vMin)) iMin = i;
      const evid: Record<string, unknown> = {};
      for (const k of ["tensao_repouso_v", "tensao_min_voo_v", "queda_por_celula_v", "corrente_media_voo_a",
        "resistencia_interna_ohm"]) evid[k] = info[k];
      evento(eventos, "bateria_queda_sob_carga", "Bateria", gravidade, t[iMin], t[iMin], "Queda de tensão sob carga",
        `De ${fmtPy(vRep, 2)} V em repouso para ${fmtPy(vMin, 2)} V em voo: ${fmtPy(queda, 2)} V por célula ` +
        `com ~${fmtPy(corrMedia, 0)} A.`, evid, "BAT.Volt, BAT.Curr");
    }
  }

  const limite = ficha.propulsao.corrente_maxima_a;
  if (limite && qualquer(Array.from(corr, Number.isFinite))) {
    for (const [ini, fim, idx] of intervalos(t, Array.from(corr, (x) => (Number.isNaN(x) ? 0 : x) > limite),
      lim("corrente_duracao_s"))) {
      const pico = max(pick(corr, idx));
      evento(eventos, "corrente_acima_limite", "Bateria", "atencao", ini, fim, `Corrente acima do limite de ${fmtPy(limite, 0)} A`,
        `Pico de ${fmtPy(pico, 0)} A por ${fmtPy(fim - ini, 1)} s.`, { pico_a: pyRound(pico, 1) }, "BAT.Curr");
    }
  }
  return info;
}

function vibracao(eventos: Evento[], dados: Log, origem: number, voos: Voo[], impactos: [number, number][]) {
  const vibe0 = dados.VIBE;
  if (!vibe0 || !vibe0.n) return;
  const vibe = filtrarInstancia(vibe0, "IMU");
  const t = segundos(vibe, origem);
  // Vibração e clipping no impacto são consequência da batida, não do voo.
  const ev = emVoo(t, voos, impactos);
  const X = col(vibe, "VibeX"), Y = col(vibe, "VibeY"), Z = col(vibe, "VibeZ");
  const maximo = Float64Array.from(X, (x, i) => maxNp([x, Y[i], Z[i]]));
  const atencao = lim("vibracao_atencao_ms2"), critica = lim("vibracao_critica_ms2");
  const dt = Float64Array.from(t, (x, i) => (i + 1 < t.length ? t[i + 1] - x : 0));
  for (const [ini, fim, idx] of intervalos(t, Array.from(maximo, (m, i) => m > atencao && !!ev[i]),
    lim("vibracao_duracao_s"), 2.0)) {
    const eixos: [string, number][] = [["VibeX", max(pick(X, idx))], ["VibeY", max(pick(Y, idx))], ["VibeZ", max(pick(Z, idx))]];
    let acimaCritico = 0;
    for (const i of idx) if (maximo[i] > critica) acimaCritico += dt[i];
    const gravidade = acimaCritico >= lim("vibracao_duracao_s") ? "critico" : "atencao";
    const evid: Record<string, unknown> = Object.fromEntries(eixos.map(([k, v]) => [k, pyRound(v, 1)]));
    evid.segundos_acima_atencao = pyRound(fim - ini, 1);
    evid.segundos_acima_critico = pyRound(acimaCritico, 1);
    let pior = eixos[0];
    for (const e of eixos) if (e[1] > pior[1]) pior = e;
    evento(eventos, "vibracao_alta", "Vibração", gravidade, ini, fim,
      `Vibração acima de ${fmtPy(gravidade === "critico" ? critica : atencao, 0)} m/s²`,
      `Máximo de ${fmtPy(pior[1], 0)} m/s² (eixo ${pior[0].slice(-1)}) em ${fmtPy(fim - ini, 1)} s acima de ` +
      `${fmtPy(atencao, 0)} m/s², dos quais ${fmtPy(acimaCritico, 1)} s acima de ${fmtPy(critica, 0)} m/s².`,
      evid, "VIBE");
  }
  const coluna = vibe.num.Clip ? "Clip" : vibe.num.Clip0 ? "Clip0" : null;
  if (impactos.length) {
    const evTodo = emVoo(t, voos);
    const noImpacto = Array.from(t, (_, i) => !!evTodo[i] && !ev[i]);
    if (qualquer(noImpacto)) {
      const pico = maxNp(ondeM(maximo, noImpacto));
      const clipImp = coluna ? ondeM(col(vibe, coluna), noImpacto) : null;
      if (pico > atencao) {
        const ti = ondeM(t, noImpacto);
        evento(eventos, "vibracao_impacto", "Vibração", "info", ti[0], ti[ti.length - 1], "Pico de vibração no impacto",
          `${fmtPy(pico, 0)} m/s²` + (clipImp ? ` e ${Math.trunc(maxNp(clipImp) - minNp(clipImp))} clippings` : "") +
          " no momento da batida — consequência do impacto, não um problema do voo.", { pico_ms2: pyRound(pico, 1) }, "VIBE");
      }
    }
  }
  if (qualquer(ev)) {
    const tv = ondeM(t, ev);
    const p99 = percentil(ondeM(maximo, ev), 99);
    if (p99 <= atencao) {
      evento(eventos, "vibracao_ok", "Vibração", "info", tv[0], tv[tv.length - 1], "Vibração em voo normal",
        `99% das leituras em voo abaixo de ${fmtPy(p99, 0)} m/s² (limite ${fmtPy(atencao, 0)}).`, { p99_ms2: pyRound(p99, 1) }, "VIBE");
    }
    if (coluna) {
      // Soma só os aumentos entre leituras consecutivas em voo (o contador é cumulativo).
      const clip = col(vibe, coluna);
      let aumento = 0, primeiro = -1;
      for (let i = 1; i < vibe.n; i++) {
        const subida = clip[i] - clip[i - 1];
        if (ev[i] && ev[i - 1] && subida > 0) { aumento += subida; if (primeiro < 0) primeiro = i; }
      }
      aumento = Math.trunc(aumento);
      if (aumento >= lim("clip_aumento")) {
        evento(eventos, "clipping", "Vibração", "atencao", t[primeiro], tv[tv.length - 1], "Acelerômetro saturou (clipping)",
          `O contador de clipping subiu ${aumento} vezes durante o voo.`, { aumento }, `VIBE.${coluna}`);
      }
    }
  }
}

function gps(eventos: Evento[], dados: Log, origem: number, voos: Voo[]) {
  const g0 = dados.GPS;
  if (!g0 || !g0.n) return;
  const g = filtrarInstancia(g0, "I");
  const t = segundos(g, origem);
  const ev = emVoo(t, voos);
  const status = col(g, "Status");
  const semFix: boolean[] = [];
  let teveFix = false;
  for (let i = 0; i < g.n; i++) { teveFix ||= status[i] >= 3; semFix.push(status[i] < 3 && teveFix); }
  for (const [ini, fim, idx] of intervalos(t, semFix, 0.5)) {
    const voando = algumEm(ev, idx);
    evento(eventos, "gps_sem_fix", "GPS", voando ? "critico" : "info", ini, fim, "GPS perdeu o fix 3D",
      `Sem fix por ${fmtPy(fim - ini, 1)} s` + (voando ? " durante o voo." : " (no solo)."),
      { status_min: Math.trunc(minNp(pick(status, idx))) }, "GPS.Status");
  }
  const validos = Array.from(status, (s) => s >= 3);
  if (g.num.HDop) {
    const hdop = g.num.HDop;
    for (const [ini, fim, idx] of intervalos(t, Array.from(hdop, (h, i) => h > lim("hdop_max") && !!ev[i] && validos[i]), 1.0)) {
      const m = maxNp(pick(hdop, idx));
      evento(eventos, "gps_hdop_alto", "GPS", "atencao", ini, fim, "Precisão do GPS ruim (HDop alto)",
        `HDop até ${fmtPy(m, 1)} em voo.`, { hdop_max: pyRound(m, 2) }, "GPS.HDop");
    }
  }
  if (g.num.NSats) {
    const sats = g.num.NSats;
    for (const [ini, fim, idx] of intervalos(t, Array.from(sats, (s, i) => s < lim("satelites_min") && !!ev[i] && validos[i]), 1.0)) {
      const m = minNp(pick(sats, idx));
      evento(eventos, "gps_poucos_satelites", "GPS", "atencao", ini, fim, "Poucos satélites",
        `Mínimo de ${m} satélites em voo.`, { satelites_min: Math.trunc(m) }, "GPS.NSats");
    }
  }
  const gv = filtrar(g, validos);
  if (gv.n > 2) {
    const tg = segundos(gv, origem);
    const lat = col(gv, "Lat"), lng = col(gv, "Lng");
    for (let i = 0; i + 1 < gv.n; i++) {
      const dist = haversine(lat[i], lng[i], lat[i + 1], lng[i + 1]);
      const dt = Math.max(tg[i + 1] - tg[i], 1e-3);
      if (dist / dt > lim("gps_salto_ms")) {
        evento(eventos, "gps_salto", "GPS", "atencao", tg[i], tg[i + 1], "Salto de posição do GPS",
          `A posição pulou ${fmtPy(dist, 0)} m em ${fmtPy(dt, 2)} s — fisicamente impossível.`,
          { distancia_m: pyRound(dist, 1) }, "GPS.Lat/Lng");
      }
    }
  }
}

function controle(eventos: Evento[], dados: Log, origem: number, voos: Voo[], ficha: Ficha) {
  if (!controladoraComanda(ficha) || !ficha.controladora.calibrada) return;
  const att = dados.ATT;
  if (!att || !att.n || !att.num.DesRoll) return;
  const t = segundos(att, origem);
  const ev = emVoo(t, voos);
  for (const eixo of ["Roll", "Pitch"]) {
    const des = col(att, `Des${eixo}`), real = col(att, eixo);
    const erro = Float64Array.from(des, (d, i) => Math.abs(d - real[i]));
    for (const [ini, fim, idx] of intervalos(t, Array.from(erro, (e, i) => e > lim("controle_erro_graus") && !!ev[i]),
      lim("controle_duracao_s"))) {
      const m = maxNp(pick(erro, idx));
      evento(eventos, "controle_nao_segue", "Controle", "atencao", ini, fim, `O avião não seguiu o ${eixo.toLowerCase()} pedido`,
        `Diferença de até ${fmtPy(m, 0)}° entre o pedido e o real por ${fmtPy(fim - ini, 1)} s.`,
        { erro_max_graus: pyRound(m, 1) }, `ATT.Des${eixo}/${eixo}`);
    }
  }
}

function atitudeETrajetoria(eventos: Evento[], dados: Log, origem: number, voos: Voo[], atitude: SerieAtitude | null,
                            fonteAtitude: string | null) {
  if (!atitude || !voos.length) return;
  const confianca = fonteAtitude === "reprocessada" ? "media" : "alta";
  const t = atitude.t;
  const ev = emVoo(t, voos);
  const roll = atitude.Roll, pitch = atitude.Pitch;
  for (const [ini, fim, idx] of intervalos(t, Array.from(roll, (r, i) => Math.abs(r) > lim("roll_extremo_graus") && !!ev[i]), 0.3)) {
    const v = argmaxAbs(pick(roll, idx));
    evento(eventos, "roll_extremo", "Atitude", "atencao", ini, fim, "Inclinação lateral extrema",
      `Roll de até ${fmtPy(v, 0, true)}°.`, { roll_max_graus: pyRound(v, 0) }, `atitude ${fonteAtitude}`, confianca);
  }
  for (const [ini, fim, idx] of intervalos(t, Array.from(pitch, (p, i) => Math.abs(p) > lim("pitch_extremo_graus") && !!ev[i]), 0.3)) {
    const v = argmaxAbs(pick(pitch, idx));
    evento(eventos, "pitch_extremo", "Atitude", "atencao", ini, fim, "Pitch extremo",
      `Pitch de até ${fmtPy(v, 0, true)}°.`, { pitch_max_graus: pyRound(v, 0) }, `atitude ${fonteAtitude}`, confianca);
  }

  const g = gpsValido(dados);
  if (!g || !g.num.VZ) return;
  const tg = segundos(g, origem);
  const vel = col(g, "Spd"), vz = col(g, "VZ");
  const gama = Float64Array.from(vel, (v, i) => graus(Math.atan2(-vz[i], Math.max(v, 0.1))));
  const evg = emVoo(tg, voos);
  const voando = Array.from(vel, (v, i) => !!evg[i] && v > 6);
  for (const [ini, fim, idx] of intervalos(tg, Array.from(gama, (x, i) => x < lim("descida_ingreme_graus") && voando[i]),
    lim("descida_ingreme_duracao_s"))) {
    const gMin = minNp(pick(gama, idx)), vMax = maxNp(pick(vel, idx));
    evento(eventos, "descida_ingreme", "Trajetória", "atencao", ini, fim, "Descida íngreme",
      `Trajetória até ${fmtPy(gMin, 0)}° abaixo do horizonte, a até ${fmtPy(vMax, 0)} m/s.`,
      { angulo_trajetoria_min_graus: pyRound(gMin, 0), velocidade_max_ms: pyRound(vMax, 1) }, "GPS.VZ/Spd");
  }
  // Ângulo de ataque aproximado = pitch − trajetória (sem Pitot: confiança baixa).
  const p = interpLR(tg, t, pitch);
  const alfa = Float64Array.from(p, (x, i) => x - gama[i]);
  for (const [ini, fim, idx] of intervalos(tg, Array.from(alfa, (a, i) => a > lim("angulo_ataque_alto_graus") && voando[i]),
    lim("angulo_ataque_duracao_s"), 1.5)) {
    const aMed = mediana(pick(alfa, idx)), aMax = maxNp(pick(alfa, idx)), vMed = mediana(pick(vel, idx));
    evento(eventos, "angulo_ataque_alto", "Aerodinâmica", "atencao", ini, fim, "Ângulo de ataque estimado alto (perto do estol)",
      `Pitch − trajetória ≈ ${fmtPy(aMed, 0)}° (máx. ${fmtPy(aMax, 0)}°) por ${fmtPy(fim - ini, 0)} s, ` +
      `a ${fmtPy(vMed, 0)} m/s de velocidade no solo. Estimativa sem Pitot: o vento muda esse valor.`,
      { alfa_mediano_graus: pyRound(aMed, 1), alfa_max_graus: pyRound(aMax, 1), velocidade_mediana_ms: pyRound(vMed, 1) },
      `atitude ${fonteAtitude} + GPS`, "baixa");
  }
}

// (regex, código, categoria, gravidade se comanda, gravidade se só registra, título)
const PADROES_MENSAGEM: [RegExp, string, string, Gravidade, Gravidade, string][] = [
  [/failsafe/i, "failsafe", "Sistema", "critico", "info", "Failsafe"],
  // "yaw aligned to GPS" é o alinhamento normal do rumo após a decolagem: não entra.
  [/EKF.*(stopped aiding|lane switch|variance|yaw reset)/i, "ekf", "Estimador (EKF)", "atencao", "info", "Estimador de posição instável"],
  [/Crash/i, "crash", "Sistema", "critico", "critico", "Detecção de queda"],
  [/(Compass|Mag).*not healthy/i, "bussola", "Configuração", "atencao", "atencao", "Bússola com problema"],
  [/Roll\/Pitch inconsistent/i, "ahrs_inconsistente", "Configuração", "atencao", "atencao", "Atitude inconsistente antes do voo"],
  [/Bad fix|GPS.*not healthy/i, "gps_prearm", "GPS", "info", "info", "GPS ainda sem fix bom"],
  [/Radio failsafe|Waiting for RC|RC not/i, "rc_ausente", "Rádio", "atencao", "info", "Controladora sem sinal de rádio"],
];

function mensagens(eventos: Evento[], dados: Log, origem: number, ficha: Ficha, voos: Voo[]) {
  const msg = dados.MSG;
  if (!msg || !msg.n) return;
  const comanda = controladoraComanda(ficha);
  const t = segundos(msg, origem);
  const textos = msg.txt.Message;
  for (const [padrao, codigo, categoria, gComanda, gRegistra, titulo] of PADROES_MENSAGEM) {
    const casou = textos.map((x) => padrao.test(x));
    if (!casou.some(Boolean)) continue;
    const exemplos = [...new Set(textos.filter((_, i) => casou[i]))].slice(0, 4);
    let gravidade = comanda ? gComanda : gRegistra;
    // PreArm = checagem antes de armar; não é algo que "aconteceu durante o voo".
    const reais = casou.map((c, i) => c && !textos[i].startsWith("PreArm"));
    const soPrearm = !reais.some(Boolean);
    let contadas = reais;
    if (soPrearm) { gravidade = "info"; contadas = casou; }
    const noVoo = qualquer(emVoo(ondeM(t, reais), voos));
    let observacao = comanda ? "" : " A controladora só registra (não comanda o avião), então isto não afetou o voo diretamente.";
    if (soPrearm) observacao += " Só avisos PreArm (checagem antes de armar), nenhum durante o voo.";
    const tc = ondeM(t, contadas);
    evento(eventos, `msg_${codigo}`, categoria, gravidade, tc[0], tc[tc.length - 1], titulo,
      `${tc.length} mensagem(ns)${noVoo ? " durante o voo" : ""}: ` + exemplos.join(" | ") + observacao,
      { quantidade: tc.length, so_prearm: soPrearm, exemplos }, "MSG");
  }
}

/** Desvio padrão amostral do pandas (ddof=1, ignora NaN). */
function stdPandas(v: ArrayLike<number>): number {
  const x = Array.from(v).filter((a) => !Number.isNaN(a));
  if (x.length < 2) return NaN;
  const m = x.reduce((s, a) => s + a, 0) / x.length;
  return Math.sqrt(x.reduce((s, a) => s + (a - m) ** 2, 0) / (x.length - 1));
}

function configuracao(eventos: Evento[], dados: Log, origem: number, ficha: Ficha, voos: Voo[],
                      deteccao: DeteccaoOrientacao): string[] {
  const qualidade: string[] = [];
  if (deteccao.orientacao === "invertida_180") {
    const configurada = Math.trunc(parametro(dados, "AHRS_ORIENTATION") ?? 0);
    evento(eventos, "placa_invertida", "Configuração", "critico", deteccao.inicio_corrida_s, deteccao.fim_corrida_s,
      "Controladora montada ao contrário (girada 180°)",
      `Na corrida de decolagem o GPS mostra +${fmtPy(deteccao.aceleracao_gps_ms2!, 1)} m/s² para a frente, mas o ` +
      `acelerômetro X variou ${fmtPy(deteccao.variacao_acc_x_ms2!, 1, true)} m/s² (para trás). AHRS_ORIENTATION = ` +
      `${configurada}; para placa com a seta para trás deveria ser 4 (Yaw180). Roll/pitch gravados pelo ` +
      "ArduPilot (ATT) estão errados neste log — a análise usa a atitude recalculada.",
      { ...deteccao }, "IMU.AccX + GPS.Spd");
    qualidade.push("Atitude gravada (ATT/AHR2/AOA) não confiável: placa ao contrário. Usada atitude recalculada da IMU.");
  }
  if (!ficha.controladora.calibrada) {
    qualidade.push("Ficha indica acelerômetro/nível não calibrados: erros de alguns graus em roll/pitch.");
  }
  const refs = referenciasAltitude(dados, origem);
  for (const voo of voos) {
    const janela = cortarJanela(dados, voo.inicio_s, voo.fim_s, origem);
    const div = divergenciaAltitude(janela, origem, refs);
    if (div && div.p95_m > lim("divergencia_altitude_m")) {
      evento(eventos, "barometro_contaminado", "Sensores", "atencao", voo.inicio_s, voo.fim_s, "Barômetro e GPS discordam em voo",
        `Diferença de até ${fmtPy(div.max_m, 0)} m (aos ${mmssPy(div.t)}). Saltos rápidos no barômetro ` +
        "costumam vir do fluxo de ar/hélice: proteja o sensor com espuma.",
        { max_m: pyRound(div.max_m, 1), p95_m: pyRound(div.p95_m, 1) }, "BARO.Alt vs GPS.Alt");
      qualidade.push("Altitude pelo barômetro não confiável em voo (contaminada pelo fluxo de ar); preferir GPS.");
    }
  }
  if (!controladoraComanda(ficha)) {
    qualidade.push("Controladora só registra: modos de voo, failsafes e saídas (RCOU) não comandaram o avião.");
    const rcin = dados.RCIN;
    // pandas: rcin.filter(like="C").nunique().max() <= 1 (sem colunas = NaN = falso)
    let maxUnicos = rcin ? NaN : 0;
    if (rcin) {
      for (const c of rcin.ordem) {
        if (!c.includes("C") || !(c in rcin.num)) continue;
        if (Number.isNaN(maxUnicos)) maxUnicos = 0;
        const u = new Set(Array.from(rcin.num[c]).filter((x) => !Number.isNaN(x)));
        maxUnicos = Math.max(maxUnicos, u.size);
      }
    }
    if (!rcin || maxUnicos <= 1) qualidade.push("Comandos do piloto não registrados (rádio não ligado à controladora).");
  }
  if (!dados.ARSP) {
    qualidade.push("Sem tubo de Pitot: velocidade só em relação ao solo (GPS); o vento afeta velocidades e ângulos.");
  } else if (Math.trunc(parametro(dados, "ARSPD_TYPE") ?? 1) === 0 || Math.trunc(parametro(dados, "ARSPD_USE") ?? 1) === 0) {
    qualidade.push("Mensagens ARSP gravadas, mas o sensor de velocidade do ar está desativado/não usado " +
      "(ARSPD_TYPE/ARSPD_USE = 0): ignorar ARSP; velocidade só pelo GPS.");
  }
  const vibe = dados.VIBE;
  if (vibe && vibe.n && vibe.num.VibeX && vibe.num.VibeY && vibe.num.VibeZ) {
    const eixos = [vibe.num.VibeX, vibe.num.VibeY, vibe.num.VibeZ];
    const medias = eixos.map((e) => mediaSemNaN(e));
    const desvio = Math.max(...eixos.map(stdPandas));
    // VIBE é desvio da aceleração (perto de 0 parado); média perto de 1 g ou 2 g = aceleração bruta.
    if (medias.some((m) => [9.81, 19.62].some((g) => Math.abs(m - g) < 1.0)) && desvio < 2) {
      qualidade.push(`VIBE com média suspeita (${medias.map((m) => fmtPy(m, 1)).join(", ")} m/s², quase constante): ` +
        "parece aceleração bruta, não vibração. Confirmar pela IMU antes de concluir sobre vibração.");
    }
  }
  const dsf = dados.DSF;
  if (dsf && dsf.num.Dp && max(dsf.num.Dp) > 0) {
    evento(eventos, "log_perdeu_mensagens", "Sistema", "atencao", null, null, "Log perdeu mensagens",
      `${Math.trunc(max(dsf.num.Dp))} mensagens descartadas pelo registrador.`, {}, "DSF.Dp");
  }
  return qualidade;
}

function mediaSemNaN(v: ArrayLike<number>): number {
  let s = 0, n = 0;
  for (let i = 0; i < v.length; i++) if (!Number.isNaN(v[i])) { s += v[i]; n++; }
  return n ? s / n : NaN;
}

// -----------------------------------------------------------------------
// Função principal
// -----------------------------------------------------------------------
export interface ResultadoEventos {
  eventos: Evento[];
  voos: Voo[];
  atitude: { fonte: string | null; orientacao_usada: string; deteccao_orientacao: DeteccaoOrientacao };
  atitude_serie: SerieAtitude | null;
  bateria: Record<string, unknown>;
  qualidade_dados: string[];
}

/** Roda todos os detectores sobre o log inteiro. */
export function detectar(dados: Log, ficha: Ficha): ResultadoEventos {
  const origem = origemUs(dados);
  const voos = detectarVoos(dados, origem);
  const deteccao = detectarOrientacao(dados, origem);

  // Atitude recalculada quando a placa está fora da posição/calibração; senão a gravada.
  const orientacao = deteccao.orientacao || ficha.controladora.orientacao || "normal";
  const reprocessar = orientacao !== "normal" || !ficha.controladora.calibrada;
  let atitude: SerieAtitude | null = null;
  let fonteAtitude: string | null = null;
  if (reprocessar && dados.IMU) {
    const inicio = voos.length ? Math.max(0, voos[0].inicio_s - 120) : null;
    const fim = voos.length ? voos[voos.length - 1].fim_s + 30 : null;
    atitude = reprocessarAtitude(dados, orientacao, inicio, fim);
    fonteAtitude = "reprocessada";
  } else if (dados.ATT) {
    const att = dados.ATT as Mensagem;
    atitude = { TimeUS: Float64Array.from(col(att, "TimeUS")), t: segundos(att, origem), Roll: col(att, "Roll"),
      Pitch: col(att, "Pitch"), Yaw: col(att, "Yaw") };
    fonteAtitude = "ATT";
  }

  const eventos: Evento[] = [];
  for (const voo of voos) {
    evento(eventos, "decolagem", "Fases do voo", "info", voo.inicio_s, voo.inicio_s, "Início do movimento (corrida/decolagem)",
      `Velocidade GPS passa de ${fmtPy(lim("velocidade_voo_ms"), 0)} m/s; trecho de ${fmtPy(voo.duracao_s, 0)} s, ` +
      `máx. ${fmtPy(voo.velocidade_max_ms, 0)} m/s.`, { ...voo }, "GPS.Spd");
    fimDoVoo(eventos, dados, origem, voo, atitude);
  }
  const impactos = eventos.filter((e) => e.codigo === "impacto").map((e) => [e.inicio_s!, e.fim_s!] as [number, number]);
  const resumoBateria = bateria(eventos, dados, origem, ficha, voos, impactos);
  vibracao(eventos, dados, origem, voos, impactos);
  gps(eventos, dados, origem, voos);
  controle(eventos, dados, origem, voos, ficha);
  atitudeETrajetoria(eventos, dados, origem, voos, atitude, fonteAtitude);
  mensagens(eventos, dados, origem, ficha, voos);
  const qualidade = configuracao(eventos, dados, origem, ficha, voos, deteccao);

  const ordem = Object.fromEntries(GRAVIDADES.map((g, i) => [g, i]));
  eventos.sort((a, b) => ((a.inicio_s ?? -1) - (b.inicio_s ?? -1)) || ordem[a.gravidade] - ordem[b.gravidade]);
  return {
    eventos,
    voos,
    atitude: { fonte: fonteAtitude, orientacao_usada: orientacao, deteccao_orientacao: deteccao },
    atitude_serie: atitude,
    bateria: resumoBateria,
    qualidade_dados: [...new Set(qualidade)],
  };
}
