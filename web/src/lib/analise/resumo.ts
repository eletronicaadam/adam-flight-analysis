/**
 * resumo.ts — porta de analysis/battery.py, gps.py, flight_performance.py,
 * imu_vibration.py e statistics.py. As chaves do resumo são as mesmas do
 * Python, para o histórico (CSV) continuar compatível.
 */
import {
  col, distanciaPercorrida, filtrar, filtrarInstancia, mascara, max, media, min, tempoRelativo, trapezio,
  type Log, type Mensagem,
} from "../tabela";

export type Metricas = Record<string, number | string>;
export type Resumo = Record<string, Metricas | { erro: string }>;

export function analisarBateria(bat: Mensagem, instancia = 0): Metricas {
  bat = filtrarInstancia(bat, "Inst", instancia);
  if (bat.n < 2) throw new Error("Mensagens BAT insuficientes para calcular consumo.");
  const t = tempoRelativo(bat);
  const tensao = col(bat, "Volt");
  const corrente = col(bat, "Curr");
  const potencia = tensao.map((v, i) => v * corrente[i]);

  // Monitores só de tensão gravam a corrente como NaN: integra só as
  // amostras com tensão e corrente válidas.
  const val: number[] = [];
  for (let i = 0; i < bat.n; i++) if (!Number.isNaN(tensao[i]) && !Number.isNaN(corrente[i])) val.push(i);
  let consumoAs = NaN, energiaWs = NaN;
  if (val.length >= 2) {
    const tv = val.map((i) => t[i]);
    consumoAs = trapezio(val.map((i) => corrente[i]), tv);
    energiaWs = trapezio(val.map((i) => potencia[i]), tv);
  }
  return {
    tensao_minima_v: min(tensao),
    tensao_maxima_v: max(tensao),
    corrente_maxima_a: max(corrente),
    corrente_media_a: media(corrente),
    potencia_maxima_w: max(potencia),
    potencia_media_w: media(potencia),
    consumo_mah: (consumoAs / 3600) * 1000,
    consumo_wh: energiaWs / 3600,
  };
}

export function analisarGps(gps: Mensagem, instancia = 0): Metricas {
  gps = filtrarInstancia(gps, "I", instancia);
  const total = gps.n;
  const status = col(gps, "Status");
  const ok = filtrar(gps, mascara(gps, (i) => status[i] >= 3));
  if (ok.n < 2) {
    throw new Error(
      "Este log não tem fix 3D suficiente para calcular métricas de trajetória. " +
      "Verifique a qualidade do GPS durante o voo.",
    );
  }
  const t = tempoRelativo(ok);
  const alt = col(ok, "Alt");
  const spd = col(ok, "Spd");
  return {
    duracao_s: t[t.length - 1],
    distancia_percorrida_m: distanciaPercorrida(col(ok, "Lat"), col(ok, "Lng")),
    altitude_maxima_m: max(alt.map((a) => a - alt[0])),
    velocidade_maxima_ms: max(spd),
    velocidade_media_ms: media(spd),
    hdop_medio: media(col(ok, "HDop")),
    satelites_media: media(col(ok, "NSats")),
    percentual_fix_3d: (ok.n / total) * 100,
  };
}

/** Python: max(0.0, x) devolve 0.0 quando x é NaN. */
const max0 = (x: number) => (x > 0 ? x : 0);

export function analisarAltitude(baro: Mensagem, janelaS = 1.0, instancia = 0): Metricas {
  baro = filtrarInstancia(baro, "I", instancia);
  if (baro.n < 2) throw new Error("Mensagens de altitude insuficientes para análise.");
  const t = tempoRelativo(baro);
  const alt = col(baro, "Alt");

  // Médias por janela de tempo (groupby), na ordem dos grupos.
  const grupos = new Map<number, { st: number; nt: number; sa: number; na: number }>();
  for (let i = 0; i < baro.n; i++) {
    const g = Math.floor(t[i] / janelaS);
    let e = grupos.get(g);
    if (!e) grupos.set(g, (e = { st: 0, nt: 0, sa: 0, na: 0 }));
    if (!Number.isNaN(t[i])) { e.st += t[i]; e.nt++; }
    if (!Number.isNaN(alt[i])) { e.sa += alt[i]; e.na++; }
  }
  const chaves = [...grupos.keys()].sort((a, b) => a - b);
  const tg = chaves.map((k) => { const e = grupos.get(k)!; return e.nt ? e.st / e.nt : NaN; });
  const ag = chaves.map((k) => { const e = grupos.get(k)!; return e.na ? e.sa / e.na : NaN; });
  const taxa: number[] = [];
  for (let i = 1; i < tg.length; i++) taxa.push((ag[i] - ag[i - 1]) / (tg[i] - tg[i - 1]));

  return {
    duracao_s: t[t.length - 1],
    altitude_maxima_m: max(alt.map((a) => a - alt[0])),
    taxa_subida_maxima_ms: max0(max(taxa)),
    taxa_descida_maxima_ms: max0(-min(taxa)),
  };
}

export function analisarVibracao(vibe: Mensagem, imu = 0): Metricas {
  const v = filtrarInstancia(vibe, "IMU", imu);
  if (v.n === 0) throw new Error(`Nenhuma mensagem VIBE para a IMU ${imu}.`);
  const clip = v.num["Clip"] ?? col(v, `Clip${imu}`);
  return {
    vibe_x_media: media(col(v, "VibeX")),
    vibe_x_maxima: max(col(v, "VibeX")),
    vibe_y_media: media(col(v, "VibeY")),
    vibe_y_maxima: max(col(v, "VibeY")),
    vibe_z_media: media(col(v, "VibeZ")),
    vibe_z_maxima: max(col(v, "VibeZ")),
    clipping_total: Math.trunc(clip[v.n - 1]),
  };
}

function tentar(f: () => Metricas): Metricas | { erro: string } {
  try {
    return f();
  } catch (e) {
    return { erro: e instanceof Error ? e.message : String(e) };
  }
}

/** statistics.resumir_voo: roda todas as análises disponíveis. */
export function resumirVoo(dados: Log): Resumo {
  const r: Resumo = {};
  if (dados.BAT) r.bateria = tentar(() => analisarBateria(dados.BAT));
  if (dados.GPS) r.gps = tentar(() => analisarGps(dados.GPS));
  if (dados.BARO) {
    r.altitude = tentar(() => ({ ...analisarAltitude(dados.BARO), fonte: "BARO" }));
  } else if (dados.GPS) {
    r.altitude = tentar(() => {
      const st = col(dados.GPS, "Status");
      const comFix = filtrar(dados.GPS, mascara(dados.GPS, (i) => st[i] >= 3));
      return { ...analisarAltitude(comFix), fonte: "GPS (BARO indisponível)" };
    });
  }
  if (dados.VIBE) r.vibracao = tentar(() => analisarVibracao(dados.VIBE));
  return r;
}
