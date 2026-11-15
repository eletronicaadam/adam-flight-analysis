/**
 * atitude.ts — porta de analysis/atitude.py: recalcula roll/pitch/yaw a
 * partir da IMU (filtro complementar de Mahony com quatérnio), corrigindo
 * a orientação de montagem da placa, e detecta placa montada ao contrário
 * pela física da corrida de decolagem.
 */
import type { Log, Mensagem } from "../dataflash";
import { col, filtrar, filtrarInstancia, mascara, mediana } from "../tabela";
import type { Ficha } from "../ficha";
import { gradiente, graus, interpLR, mediaMovelSame, mediaSimples, modPy, pyRound } from "../numerico";

const G = 9.80665;
export const ORIENTACOES: Record<string, [number, number, number]> = {
  normal: [1, 1, 1],
  invertida_180: [-1, -1, 1], // seta para trás (Yaw180)
};
const KP_GRAVIDADE = 0.6;
const KP_RUMO = 0.3;
const VELOCIDADE_MIN_RUMO_MS = 5.0;

export interface SerieAtitude {
  TimeUS: Float64Array;
  t: Float64Array;
  Roll: Float64Array;
  Pitch: Float64Array;
  Yaw: Float64Array;
}

/** Menor TimeUS de todas as mensagens (como o atitude.py calcula a origem). */
export function origemBruta(dados: Log): number {
  let m = Infinity;
  for (const df of Object.values(dados)) {
    const t = df.num.TimeUS;
    if (!t || !df.n) continue;
    for (let i = 0; i < t.length; i++) if (t[i] < m) m = t[i];
  }
  return m;
}

const seg = (m: Mensagem, origem: number) => col(m, "TimeUS").map((x) => (x - origem) / 1e6);

function quatParaEuler(q0: number, q1: number, q2: number, q3: number): [number, number, number] {
  const roll = Math.atan2(2 * (q0 * q1 + q2 * q3), 1 - 2 * (q1 * q1 + q2 * q2));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (q0 * q2 - q3 * q1))));
  const yaw = Math.atan2(2 * (q0 * q3 + q1 * q2), 1 - 2 * (q2 * q2 + q3 * q3));
  return [roll, pitch, yaw];
}

function eulerParaQuat(roll: number, pitch: number, yaw: number): [number, number, number, number] {
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  return [cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy];
}

/** Aceleração NED (m/s²) pela velocidade do GPS, suavizada em ~1 s. */
function aceleracaoGps(gps: Mensagem, origem: number) {
  const t = seg(gps, origem);
  const rumo = col(gps, "GCrs").map((g) => (g * Math.PI) / 180);
  const vel = Float64Array.from(col(gps, "Spd"));
  const n = t.length;
  const vn = vel.map((v, i) => v * Math.cos(rumo[i]));
  const ve = vel.map((v, i) => v * Math.sin(rumo[i]));
  const vd = gps.num.VZ ? Float64Array.from(gps.num.VZ) : new Float64Array(n);
  if (n < 3) return { t, acc: [new Float64Array(n), new Float64Array(n), new Float64Array(n)], vel, rumo };
  let acc = [gradiente(vn, t), gradiente(ve, t), gradiente(vd, t)];
  const dts = new Float64Array(n - 1);
  for (let i = 1; i < n; i++) dts[i - 1] = t[i] - t[i - 1];
  const janela = Math.max(1, pyRound(1.0 / Math.max(mediana(dts), 1e-3)));
  if (janela > 1) acc = acc.map((a) => mediaMovelSame(a, janela));
  return { t, acc, vel, rumo };
}

/**
 * Recalcula roll/pitch/yaw (graus) a partir de IMU + GPS no trecho
 * [inicio, fim] (segundos desde o início do log). null se não há IMU.
 */
export function reprocessarAtitude(dados: Log, orientacao = "normal", inicio: number | null = null,
                                   fim: number | null = null, instanciaImu = 0): SerieAtitude | null {
  const R = ORIENTACOES[orientacao];
  if (!R) throw new Error(`Orientação desconhecida: ${orientacao}. Use uma de ${Object.keys(ORIENTACOES).join(", ")}.`);
  const imu0 = dados.IMU;
  if (!imu0 || !imu0.n) return null;
  let imu = filtrarInstancia(imu0, "I", instanciaImu);
  const origem = origemBruta(dados);
  let t = seg(imu, origem);
  const tt = t;
  imu = filtrar(imu, mascara(imu, (i) => (inicio === null || tt[i] >= inicio) && (fim === null || tt[i] <= fim)));
  t = seg(imu, origem);
  if (imu.n < 10) return null;
  const n = imu.n;

  const gx0 = col(imu, "GyrX"), gy0 = col(imu, "GyrY"), gz0 = col(imu, "GyrZ");
  const ax0 = col(imu, "AccX"), ay0 = col(imu, "AccY"), az0 = col(imu, "AccZ");
  const gyr = [gx0.map((v) => v * R[0]), gy0.map((v) => v * R[1]), gz0.map((v) => v * R[2])];
  const acc = [ax0.map((v) => v * R[0]), ay0.map((v) => v * R[1]), az0.map((v) => v * R[2])];

  // GPS: aceleração para compensar manobras e rumo para o yaw.
  let accNed = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  let vel = new Float64Array(n);
  let rumo = new Float64Array(n);
  let gps = dados.GPS;
  let temGps = !!gps && gps.n > 0 && !!gps.num.GCrs;
  if (temGps) {
    gps = filtrarInstancia(gps!, "I");
    const st = col(gps, "Status");
    gps = filtrar(gps, mascara(gps, (i) => st[i] >= 3));
    temGps = gps.n >= 3;
  }
  if (temGps) {
    const a = aceleracaoGps(gps!, origem);
    accNed = a.acc.map((c) => interpLR(t, a.t, c, 0, 0));
    vel = interpLR(t, a.t, a.vel, 0, 0);
    const s = interpLR(t, a.t, a.rumo.map(Math.sin));
    const c = interpLR(t, a.t, a.rumo.map(Math.cos));
    rumo = s.map((v, i) => Math.atan2(v, c[i]));
  }

  // Bias do giroscópio: mediana com o avião parado e quieto.
  const parado: number[] = [];
  for (let i = 0; i < n; i++) {
    if (vel[i] < 0.5 && Math.hypot(gyr[0][i], gyr[1][i], gyr[2][i]) < 0.05) parado.push(i);
  }
  const bias = parado.length > 50 ? gyr.map((g) => mediana(parado.map((i) => g[i]))) : [0, 0, 0];
  for (let k = 0; k < 3; k++) for (let i = 0; i < n; i++) gyr[k][i] -= bias[k];

  // Atitude inicial pela gravidade nas primeiras amostras.
  const m0 = Math.min(50, n);
  const a0 = acc.map((a) => mediaSimples(a.subarray(0, m0)));
  const roll0 = Math.atan2(-a0[1], -a0[2]);
  const pitch0 = Math.atan2(a0[0], Math.hypot(a0[1], a0[2]));
  let [q0, q1, q2, q3] = eulerParaQuat(roll0, pitch0, rumo[0]);

  const Roll = new Float64Array(n), Pitch = new Float64Array(n), Yaw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dt = i === 0 ? 0 : t[i] - t[i - 1];
    let gx = gyr[0][i], gy = gyr[1][i], gz = gyr[2][i];
    const ax = acc[0][i], ay = acc[1][i], az = acc[2][i];
    if (dt > 0 && dt < 0.5) {
      const r11 = 1 - 2 * (q2 * q2 + q3 * q3), r12 = 2 * (q1 * q2 + q0 * q3), r13 = 2 * (q1 * q3 - q0 * q2);
      const r21 = 2 * (q1 * q2 - q0 * q3), r22 = 1 - 2 * (q1 * q1 + q3 * q3), r23 = 2 * (q2 * q3 + q0 * q1);
      const r31 = 2 * (q1 * q3 + q0 * q2), r32 = 2 * (q2 * q3 - q0 * q1), r33 = 1 - 2 * (q1 * q1 + q2 * q2);
      const an = accNed[0][i], ae = accNed[1][i], ad = accNed[2][i];
      let mx = r11 * an + r12 * ae + r13 * ad - ax;
      let my = r21 * an + r22 * ae + r23 * ad - ay;
      let mz = r31 * an + r32 * ae + r33 * ad - az;
      const norma = Math.sqrt(mx * mx + my * my + mz * mz);
      let ex = 0, ey = 0, ez = 0;
      if (0.7 * G < norma && norma < 1.3 * G) {
        mx /= norma; my /= norma; mz /= norma;
        const vx = r13, vy = r23, vz = r33;
        ex = (my * vz - mz * vy) * KP_GRAVIDADE;
        ey = (mz * vx - mx * vz) * KP_GRAVIDADE;
        ez = (mx * vy - my * vx) * KP_GRAVIDADE;
      }
      if (vel[i] > VELOCIDADE_MIN_RUMO_MS) {
        const yaw = quatParaEuler(q0, q1, q2, q3)[2];
        const erroYaw = modPy(rumo[i] - yaw + Math.PI, 2 * Math.PI) - Math.PI;
        ex += KP_RUMO * erroYaw * r13;
        ey += KP_RUMO * erroYaw * r23;
        ez += KP_RUMO * erroYaw * r33;
      }
      gx += ex; gy += ey; gz += ez;
      const dq0 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz);
      const dq1 = 0.5 * (q0 * gx + q2 * gz - q3 * gy);
      const dq2 = 0.5 * (q0 * gy - q1 * gz + q3 * gx);
      const dq3 = 0.5 * (q0 * gz + q1 * gy - q2 * gx);
      q0 += dq0 * dt; q1 += dq1 * dt; q2 += dq2 * dt; q3 += dq3 * dt;
      const nq = Math.sqrt(q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3);
      q0 /= nq; q1 /= nq; q2 /= nq; q3 /= nq;
    }
    const [r, p, y] = quatParaEuler(q0, q1, q2, q3);
    Roll[i] = graus(r);
    Pitch[i] = graus(p);
    Yaw[i] = modPy(graus(y), 360);
  }
  return { TimeUS: Float64Array.from(col(imu, "TimeUS")), t, Roll, Pitch, Yaw };
}

export interface DeteccaoOrientacao {
  orientacao: "normal" | "invertida_180" | null;
  motivo: string;
  inicio_corrida_s?: number;
  fim_corrida_s?: number;
  aceleracao_gps_ms2?: number;
  variacao_acc_x_ms2?: number;
}

/** Placa com a seta para trás? Compara a aceleração do GPS na corrida com o eixo X da IMU. */
export function detectarOrientacao(dados: Log, origem: number | null = null): DeteccaoOrientacao {
  const imu0 = dados.IMU, gps0 = dados.GPS;
  if (!imu0 || !gps0 || !imu0.n || !gps0.n) return { orientacao: null, motivo: "log sem IMU ou GPS" };
  const o = origem ?? origemBruta(dados);
  const imu = filtrarInstancia(imu0, "I");
  let gps = filtrarInstancia(gps0, "I");
  const st = col(gps, "Status");
  gps = filtrar(gps, mascara(gps, (i) => st[i] >= 3));
  const tg = seg(gps, o), ti = seg(imu, o);
  const vel = col(gps, "Spd");

  let fim = -1;
  for (let i = 0; i < gps.n; i++) if (vel[i] > 5.0) { fim = i; break; }
  if (fim < 0) return { orientacao: null, motivo: "o avião não passou de 5 m/s" };
  let ini = -1;
  for (let i = 0; i < fim; i++) if (vel[i] < 1.0) ini = i;
  if (ini < 0) return { orientacao: null, motivo: "sem trecho parado antes da decolagem" };
  const t0 = tg[ini], t1 = tg[fim];
  if (t1 - t0 < 0.5) return { orientacao: null, motivo: "corrida de decolagem curta demais" };
  const acelGps = (vel[fim] - vel[ini]) / (t1 - t0);

  const accX = col(imu, "AccX");
  const antes: number[] = [], durante: number[] = [];
  for (let i = 0; i < imu.n; i++) {
    if (ti[i] > t0 - 10 && ti[i] < t0 - 1) antes.push(accX[i]);
    if (ti[i] >= t0 && ti[i] <= t1) durante.push(accX[i]);
  }
  if (antes.length < 10 || durante.length < 10) return { orientacao: null, motivo: "poucas amostras de IMU na decolagem" };
  const deltaX = mediaSimples(durante) - mediaSimples(antes);
  const evidencia = {
    inicio_corrida_s: pyRound(t0, 1),
    fim_corrida_s: pyRound(t1, 1),
    aceleracao_gps_ms2: pyRound(acelGps, 2),
    variacao_acc_x_ms2: pyRound(deltaX, 2),
  };
  if (Math.abs(deltaX) < 0.3 || acelGps < 0.3) {
    return { orientacao: null, motivo: "aceleração pequena demais para decidir", ...evidencia };
  }
  return {
    orientacao: deltaX > 0 ? "normal" : "invertida_180",
    motivo: "eixo X do acelerômetro vs aceleração do GPS na decolagem",
    ...evidencia,
  };
}

/** Último valor de um parâmetro (PARM), ou undefined. */
export function parametro(dados: Log, nome: string): number | undefined {
  const parm = dados.PARM;
  if (!parm || !parm.txt.Name) return undefined;
  const nomes = parm.txt.Name, valores = col(parm, "Value");
  for (let i = parm.n - 1; i >= 0; i--) if (nomes[i] === nome) return valores[i];
  return undefined;
}

/**
 * Orientação a aplicar na IMU: a detectada pela física vale primeiro; a da
 * ficha só se AHRS_ORIENTATION = 0 (senão a IMU gravada já sai corrigida).
 */
export function orientacaoEfetiva(dados: Log, ficha: Ficha, deteccao: DeteccaoOrientacao): string {
  if (deteccao.orientacao) return deteccao.orientacao;
  const daFicha = ficha.controladora.orientacao || "normal";
  if (daFicha !== "normal") {
    const configurada = parametro(dados, "AHRS_ORIENTATION");
    if (configurada !== undefined && Math.trunc(configurada) !== 0) return "normal";
  }
  return daFicha;
}

/**
 * Melhor atitude para o trecho: recalculada da IMU quando a placa está
 * fora da posição ou sem calibração; senão a gravada (ATT).
 */
export function atitudeConfiavel(dados: Log, ficha: Ficha, origem: number, inicio: number | null = null,
                                 fim: number | null = null): [SerieAtitude | null, string] {
  const deteccao = detectarOrientacao(dados, origem);
  const orientacao = orientacaoEfetiva(dados, ficha, deteccao);
  const recalcular = orientacao !== "normal" || !ficha.controladora.calibrada;
  if (recalcular && dados.IMU) {
    const a = reprocessarAtitude(dados, orientacao, inicio === null ? null : Math.max(0, inicio - 60), fim);
    if (a) return [a, `recalculada da IMU (placa ${orientacao.replace(/_/g, " ")})`];
  }
  const att = dados.ATT;
  if (att && att.n) {
    const t = seg(att, origem);
    const lim = fim ?? Infinity;
    const dentro = (i: number) => inicio === null || (t[i] >= inicio - 5 && t[i] <= lim + 5);
    const idx: number[] = [];
    for (let i = 0; i < att.n; i++) if (dentro(i)) idx.push(i);
    const pick = (c: ArrayLike<number>) => Float64Array.from(idx, (i) => c[i]);
    return [{
      TimeUS: pick(col(att, "TimeUS")), t: pick(t), Roll: pick(col(att, "Roll")),
      Pitch: pick(col(att, "Pitch")), Yaw: pick(col(att, "Yaw")),
    }, "gravada pelo ArduPilot (ATT)"];
  }
  return [null, "log sem IMU/ATT"];
}
