/**
 * saude.ts — cálculos da aba Saúde do sistema (porta de
 * visualization/abas/saude.py): quadro "semáforo" por componente,
 * gráficos do EKF/CPU/GPS/temperatura/alimentação e mensagens do trecho.
 */
import type { Log, Mensagem } from "../dataflash";
import { col, filtrar, filtrarInstancia, mascara, max, media, min, percentil } from "../tabela";
import {
  DIVERGENCIA_ALTITUDE_M, colunaDeInstancia, cortarJanela, divergenciaAltitude, montarPainelPersonalizado,
  referenciasAltitude, segundos, type LinhaPainel, type Painel, type SpecSerie, type Unidades,
} from "../dadosVoo";
import { fmtPy, mmssPy, pyRound } from "../numerico";

export const LIMITES_SAUDE: Record<string, [number, string]> = {
  ekf_razao: [1.0, "razão de teste do EKF acima de 1 = medida rejeitada pelo estimador"],
  ekf_frac_critica: [0.05, "mais de 5% do tempo com medidas rejeitadas"],
  cpu_pct: [80.0, "carga da CPU acima de 80%"],
  gps_hacc_m: [5.0, "precisão horizontal do GPS pior que 5 m"],
  gps_vacc_m: [8.0, "precisão vertical do GPS pior que 8 m"],
  vcc_min_v: [4.8, "alimentação da placa abaixo de 4,8 V"],
  vcc_max_v: [5.4, "alimentação da placa acima de 5,4 V"],
};

export type Situacao = "Crítico" | "Atenção" | "OK" | "Sem dados";
const ORDEM: Record<Situacao, number> = { Crítico: 0, Atenção: 1, OK: 2, "Sem dados": 3 };

export interface ItemSaude { Componente: string; Situação: Situacao; Detalhe: string }

/** str(float) do Python: 1.0 vira "1.0", não "1". */
const strPy = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

function noTrecho(dados: Log, origem: number, tipo: string, inicio: number, fim: number,
                  instancia: number | null = null): Mensagem | null {
  let m = dados[tipo];
  if (!m || !m.n || !m.num.TimeUS) return null;
  if (instancia !== null) {
    const c = colunaDeInstancia(m);
    if (c !== null) m = filtrar(m, mascara(m, (i) => m!.num[c][i] === instancia));
  }
  const t = segundos(m, origem);
  const r = filtrar(m, mascara(m, (i) => t[i] >= inicio && t[i] <= fim));
  return r.n ? r : null;
}

const finitos = (v: ArrayLike<number>) => Array.from(v).some(Number.isFinite);

/** Quadro de saúde do trecho, do mais grave para o menos grave. */
export function avaliar(dados: Log, origem: number, inicio: number, fim: number): ItemSaude[] {
  const quadro: ItemSaude[] = [];
  const item = (Componente: string, s: Situacao, Detalhe: string) => quadro.push({ Componente, Situação: s, Detalhe });

  // --- EKF ---
  const xkf4 = noTrecho(dados, origem, "XKF4", inicio, fim, 0);
  if (xkf4) {
    const razoes = ["SV", "SP", "SH", "SM", "SVT"].filter((c) => c in xkf4.num);
    let rejeitadas = 0;
    for (let i = 0; i < xkf4.n; i++) if (razoes.some((c) => xkf4.num[c][i] > LIMITES_SAUDE.ekf_razao[0])) rejeitadas++;
    const frac = rejeitadas / xkf4.n;
    const nomes: Record<string, string> = { SV: "velocidade", SP: "posição", SH: "altura", SM: "bússola", SVT: "airspeed" };
    const detalhe = `${fmtPy(frac * 100, 1)}% do tempo com medida rejeitada. Máximos: ` +
      razoes.map((c) => `${nomes[c] ?? c} ${strPy(pyRound(max(xkf4.num[c]), 2))}`).join(", ");
    let situacao: Situacao = frac === 0 ? "OK" : frac >= LIMITES_SAUDE.ekf_frac_critica[0] ? "Crítico" : "Atenção";
    const extras: string[] = [];
    if (xkf4.num.FS && xkf4.num.FS.some((v) => v !== 0)) {
      extras.push("falhas internas do filtro (FS≠0)");
      if (situacao === "OK") situacao = "Atenção";
    }
    if (xkf4.num.TS && xkf4.num.TS.some((v) => v !== 0)) {
      extras.push("timeouts de sensores (TS≠0)");
      if (situacao === "OK") situacao = "Atenção";
    }
    item("Estimador de posição (EKF)", situacao, detalhe + (extras.length ? " · " + extras.join(", ") : ""));
  } else {
    item("Estimador de posição (EKF)", "Sem dados", "Log sem XKF4 neste trecho.");
  }

  const msg = noTrecho(dados, origem, "MSG", inicio, fim);
  if (msg) {
    const ekf = msg.txt.Message.filter((x) => /EKF/i.test(x)).length;
    if (ekf > 10) {
      item("Mensagens do EKF", "Atenção", `${ekf} mensagens do EKF no trecho ` +
        "(realinhamentos/resets repetidos indicam conflito entre sensores).");
    }
  }

  // --- CPU / memória ---
  const pm = noTrecho(dados, origem, "PM", inicio, fim);
  if (pm) {
    const carga = pm.num.Load ? pm.num.Load.map((v) => v * 0.1) : Float64Array.of(NaN);
    const longos = pm.num.NLon ? Math.trunc(pm.num.NLon.reduce((s, v) => s + (Number.isNaN(v) ? 0 : v), 0)) : 0;
    const lr = pm.num.LR ? medianaPandas(pm.num.LR) : NaN;
    const periodoUs = pm.num.LR && lr > 0 ? 1e6 / lr : null;
    const piorLoop = pm.num.MaxT ? max(pm.num.MaxT) : null;
    let situacao: Situacao = "OK";
    if (max(carga) > LIMITES_SAUDE.cpu_pct[0]) situacao = "Atenção";
    let detalhe = `Carga máx. ${fmtPy(max(carga), 0)}% (média ${fmtPy(media(carga), 0)}%)`;
    if (periodoUs && piorLoop) detalhe += ` · loop mais lento ${fmtPy(piorLoop / 1000, 1)} ms (período ${fmtPy(periodoUs / 1000, 1)} ms)`;
    if (longos) detalhe += ` · ${longos} loops longos`;
    if (pm.num.Mem) {
      detalhe += ` · memória livre mín. ${fmtPy(min(pm.num.Mem) / 1024, 0)} kB`;
      if (min(pm.num.Mem) < 4096) situacao = "Atenção";
    }
    item("Processador", situacao, detalhe);
  } else {
    item("Processador", "Sem dados", "Log sem PM neste trecho.");
  }

  // --- Gravação do log ---
  const dsf = noTrecho(dados, origem, "DSF", inicio, fim);
  if (dsf && dsf.num.Dp) {
    const perdidas = Math.trunc(max(dsf.num.Dp) - min(dsf.num.Dp));
    item("Gravação do log", perdidas ? "Atenção" : "OK", `${perdidas} mensagens perdidas no trecho` +
      (dsf.num.FMn ? ` · buffer livre mín. ${fmtPy(min(dsf.num.FMn) / 1024, 0)} kB` : ""));
  }

  // --- GPS ---
  const gps = noTrecho(dados, origem, "GPS", inicio, fim, 0);
  const gpa = noTrecho(dados, origem, "GPA", inicio, fim, 0);
  if (gps) {
    const st = col(gps, "Status");
    const comFix = filtrar(gps, mascara(gps, (i) => st[i] >= 3));
    let situacao: Situacao = "OK";
    const partes: string[] = [];
    if (comFix.n < gps.n) {
      partes.push(`${fmtPy((1 - comFix.n / gps.n) * 100, 0)}% do tempo sem fix 3D`);
      situacao = "Atenção";
    }
    if (comFix.n) partes.push(`satélites mín. ${Math.trunc(min(col(comFix, "NSats")))}, HDop máx. ${fmtPy(max(col(comFix, "HDop")), 1)}`);
    if (gpa) {
      const h = col(gpa, "HAcc"), v = col(gpa, "VAcc");
      const ok = Array.from(h, (x, i) => x < 600 && v[i] < 600);
      if (ok.some(Boolean)) {
        const hacc = percentil(h.filter((_, i) => ok[i]), 95), vacc = percentil(v.filter((_, i) => ok[i]), 95);
        partes.push(`precisão (95%): horizontal ${fmtPy(hacc, 1)} m, vertical ${fmtPy(vacc, 1)} m`);
        if (hacc > LIMITES_SAUDE.gps_hacc_m[0] || vacc > LIMITES_SAUDE.gps_vacc_m[0]) situacao = "Atenção";
      }
    }
    item("GPS", situacao, partes.join(" · "));
  } else {
    item("GPS", "Sem dados", "Log sem GPS neste trecho.");
  }

  // --- Alimentação ---
  const powr = noTrecho(dados, origem, "POWR", inicio, fim);
  if (powr && powr.num.Vcc && finitos(powr.num.Vcc)) {
    const vcc = powr.num.Vcc;
    const fora = min(vcc) < LIMITES_SAUDE.vcc_min_v[0] || max(vcc) > LIMITES_SAUDE.vcc_max_v[0];
    let detalhe = `Vcc ${fmtPy(min(vcc), 2)}–${fmtPy(max(vcc), 2)} V`;
    if (powr.num.VServo && finitos(powr.num.VServo)) {
      detalhe += ` · trilho dos servos ${fmtPy(min(powr.num.VServo), 2)}–${fmtPy(max(powr.num.VServo), 2)} V`;
    }
    item("Alimentação da placa", fora ? "Atenção" : "OK", detalhe);
  } else {
    item("Alimentação da placa", "Sem dados", "Esta placa não mede a própria tensão (POWR.Vcc vazio).");
  }

  // --- Sensores inerciais ---
  const imu = noTrecho(dados, origem, "IMU", inicio, fim, 0);
  if (imu) {
    let situacao: Situacao = "OK";
    const partes: string[] = [];
    for (const [c, nome] of [["EG", "erros do giroscópio"], ["EA", "erros do acelerômetro"]]) {
      if (imu.num[c] && max(imu.num[c]) > min(imu.num[c])) {
        partes.push(`${Math.trunc(max(imu.num[c]) - min(imu.num[c]))} ${nome}`);
        situacao = "Atenção";
      }
    }
    for (const [c, nome] of [["GH", "giroscópio"], ["AH", "acelerômetro"]]) {
      if (imu.num[c] && imu.num[c].some((v) => v === 0)) {
        partes.push(`${nome} reportou falha de saúde`);
        situacao = "Atenção";
      }
    }
    if (imu.num.T) partes.push(`temperatura ${fmtPy(min(imu.num.T), 0)}–${fmtPy(max(imu.num.T), 0)} °C`);
    item("Sensores inerciais (IMU)", situacao, partes.join(" · ") || "sem erros");
  }

  // --- Barômetro ---
  const baro = noTrecho(dados, origem, "BARO", inicio, fim, 0);
  if (baro) {
    let situacao: Situacao = "OK";
    const partes: string[] = [];
    if (baro.num.H && baro.num.H.some((v) => v === 0)) {
      partes.push("barômetro reportou falha de saúde");
      situacao = "Atenção";
    }
    const div = divergenciaAltitude(cortarJanela(dados, inicio, fim, origem), origem, referenciasAltitude(dados, origem));
    if (div && div.p95_m > DIVERGENCIA_ALTITUDE_M) {
      partes.push(`discorda do GPS em até ${fmtPy(div.max_m, 0)} m em voo (provável fluxo de ar no sensor)`);
      situacao = "Atenção";
    }
    if (baro.num.Temp) partes.push(`temperatura da placa ${fmtPy(min(baro.num.Temp), 0)}–${fmtPy(max(baro.num.Temp), 0)} °C`);
    item("Barômetro", situacao, partes.join(" · "));
  }

  // --- Bússola ---
  if (dados.MAG) {
    item("Bússola", "OK", "Bússola registrada no log.");
  } else {
    const prearm = !!msg && msg.txt.Message.some((x) => /Compass/i.test(x));
    item("Bússola", prearm ? "Atenção" : "Sem dados", "Bússola não registrada" + (prearm ? " e com aviso 'Compass not healthy'." : "."));
  }
  return quadro.sort((a, b) => ORDEM[a.Situação] - ORDEM[b.Situação]);
}

function medianaPandas(v: ArrayLike<number>): number {
  const a = Array.from(v).filter((x) => !Number.isNaN(x)).sort((p, q) => p - q);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export interface MensagemTexto { instante: string; t: number; mensagem: string }

/** Mensagens de texto (MSG) do trecho. */
export function mensagensDoTrecho(dados: Log, origem: number, inicio: number, fim: number): MensagemTexto[] | null {
  const msg = noTrecho(dados, origem, "MSG", inicio, fim);
  if (!msg) return null;
  const t = segundos(msg, origem);
  return msg.txt.Message.map((m, i) => ({ instante: mmssPy(t[i]), t: t[i], mensagem: m }));
}

export interface ResultadoSaude { quadro: ItemSaude[]; painel: Painel; mensagens: MensagemTexto[] | null }

export function prepararSaude(dados: Log, origem: number, un: Unidades, inicio: number, fim: number): ResultadoSaude {
  const quadro = avaliar(dados, origem, inicio, fim);
  const campo = (tipo: string, nome: string, rotulo: string, casas = 2, instancia = 0): SpecSerie => {
    const [unidade, fator] = un[tipo]?.[nome] ?? ["", 1.0];
    return { tipo, campo: nome, nome: rotulo, unidade, fator, casas, instancia };
  };
  const limite = (valor: number, rotulo: string): SpecSerie =>
    ({ t: [inicio, fim], y: [valor, valor], nome: rotulo, tracejado: true, cartao: false, cor: "#ff4b4b" });
  const linhas: LinhaPainel[] = [
    { titulo: "EKF: razões de teste (>1 = rejeitada)", series: [
      campo("XKF4", "SV", "EKF velocidade"), campo("XKF4", "SP", "EKF posição"),
      campo("XKF4", "SH", "EKF altura"), campo("XKF4", "SM", "EKF bússola"), limite(1.0, "limite")] },
    { titulo: "CPU (%)", series: [campo("PM", "Load", "Carga da CPU", 1)] },
    { titulo: "Loop mais lento (µs)", series: [campo("PM", "MaxT", "Loop mais lento", 0)] },
  ];
  const gpa0 = dados.GPA;
  if (gpa0 && gpa0.n) {
    const gpa = filtrarInstancia(gpa0, "I");
    const t = segundos(gpa, origem);
    // 655,35 m = "sem estimativa" (antes do fix): vira lacuna.
    const hacc = col(gpa, "HAcc").map((v) => (v < 600 ? v : NaN));
    const vacc = col(gpa, "VAcc").map((v) => (v < 600 ? v : NaN));
    linhas.push({ titulo: "Precisão do GPS (m)", series: [
      { t, y: hacc, nome: "GPS precisão horizontal", unidade: "m", casas: 1 },
      { t, y: vacc, nome: "GPS precisão vertical", unidade: "m", casas: 1 }] });
  }
  linhas.push({ titulo: "Satélites do GPS", series: [campo("GPS", "NSats", "Satélites", 0)] });
  linhas.push({ titulo: "HDop do GPS (menor = melhor; > 2 ruim)", series: [campo("GPS", "HDop", "HDop", 2)] });
  linhas.push({ titulo: "Temperatura (°C)", series: [campo("IMU", "T", "Temp. IMU", 1), campo("BARO", "Temp", "Temp. barômetro", 1)] });
  const powr = dados.POWR;
  if (powr && powr.num.Vcc && finitos(powr.num.Vcc)) {
    linhas.push({ titulo: "Alimentação (V)", series: [campo("POWR", "Vcc", "Vcc da placa"), campo("POWR", "VServo", "Trilho dos servos")] });
  }
  const painel = montarPainelPersonalizado(dados, origem, inicio, fim, linhas, false);
  return { quadro, painel, mensagens: mensagensDoTrecho(dados, origem, inicio, fim) };
}
