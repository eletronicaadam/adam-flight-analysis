/**
 * replay.ts — pacote da aba Replay 3D (porta de visualization/abas/replay.py)
 * para o painel replay_voo_web: posição local, atitude e eventos.
 */
import type { Log } from "../dataflash";
import { col, filtrarInstancia } from "../tabela";
import {
  DIVERGENCIA_ALTITUDE_M, amostrar, cortarJanela, divergenciaAltitude, gpsValido, lista, referenciasAltitude, segundos,
} from "../dadosVoo";
import { interpLR } from "../numerico";
import type { Ficha } from "../ficha";
import { atitudeConfiavel } from "../analise/atitude";
import type { Evento } from "../analise/eventos";

const MAX_PONTOS_POSICAO = 4000;
const MAX_PONTOS_ATITUDE = 8000;

export interface EventoReplay { t: number; fim: number; titulo: string; gravidade: string }

/** Eventos graves do log inteiro para marcar na barra do replay. */
export function eventosParaReplay(eventos: Evento[]): EventoReplay[] {
  return eventos
    .filter((e) => (e.gravidade === "critico" || e.gravidade === "atencao") && e.inicio_s !== null
      // mensagens de pré-voo cobrem o log todo e poluiriam a barra
      && !e.codigo.startsWith("msg_"))
    .map((e) => ({ t: e.inicio_s!, fim: e.fim_s ?? e.inicio_s!, titulo: e.titulo, gravidade: e.gravidade }));
}

/** O barômetro discorda do GPS neste trecho? (então o padrão é a altura pelo GPS) */
export function barometroRuim(dados: Log, origem: number, inicio: number, fim: number): boolean {
  const div = divergenciaAltitude(cortarJanela(dados, inicio, fim, origem), origem, referenciasAltitude(dados, origem));
  return !!div && div.p95_m > DIVERGENCIA_ALTITUDE_M;
}

export function prepararReplay(dados: Log, origem: number, ficha: Ficha, inicio: number, fim: number,
                               fonteAltura: "GPS" | "barômetro", eventos: EventoReplay[]) {
  const janela = cortarJanela(dados, inicio, fim, origem, ["GPS", "BARO"]);
  const gps = gpsValido(janela);
  const payload: Record<string, unknown> = {
    inicio, fim, envergadura_m: ficha.envergadura_m || 2.0, pos: { t: [] }, att: null,
    fonte_atitude: "", fonte_altura: fonteAltura, eventos: [],
  };
  if (!gps) return payload;

  // Posição local (m) em relação ao primeiro ponto do trecho.
  const lat = col(gps, "Lat"), lng = col(gps, "Lng");
  const lat0 = lat[0], lng0 = lng[0];
  const norte = lat.map((x) => (x - lat0) * 111_320.0);
  const leste = lng.map((x) => (x - lng0) * 111_320.0 * Math.cos((lat0 * Math.PI) / 180));
  const tGps = segundos(gps, origem);
  const refs = referenciasAltitude(dados, origem);
  let altura: Float64Array;
  if (fonteAltura === "barômetro" && janela.BARO && refs.BARO !== null) {
    const baro = filtrarInstancia(janela.BARO, "I");
    const ref = refs.BARO;
    altura = interpLR(tGps, segundos(baro, origem), col(baro, "Alt").map((a) => a - ref));
  } else {
    const ref = refs.GPS ?? col(gps, "Alt")[0];
    altura = col(gps, "Alt").map((a) => a - ref);
  }
  const passo = Math.max(1, Math.ceil(gps.n / MAX_PONTOS_POSICAO));
  const s = new Set<number>();
  for (let i = 0; i < gps.n; i += passo) s.add(i);
  s.add(gps.n - 1);
  const colunas: Record<string, ArrayLike<number>> = { e: leste, n: norte, u: altura, v: col(gps, "Spd") };
  if (gps.num.GCrs) colunas.rumo = gps.num.GCrs;
  const { tSel, sel } = amostrar(tGps, Int32Array.from(s).sort(), colunas);
  payload.pos = { t: lista(tSel, 3), ...Object.fromEntries(Object.entries(sel).map(([k, v]) => [k, lista(v, 2)])) };

  const [atitude, fonte] = atitudeConfiavel(dados, ficha, origem, inicio, fim);
  payload.fonte_atitude = fonte;
  if (atitude) {
    const idx: number[] = [];
    for (let i = 0; i < atitude.t.length; i++) if (atitude.t[i] >= inicio && atitude.t[i] <= fim) idx.push(i);
    const p = Math.max(1, Math.ceil(idx.length / MAX_PONTOS_ATITUDE));
    const esc = idx.filter((_, k) => k % p === 0);
    const pick = (v: Float64Array) => esc.map((i) => v[i]);
    payload.att = { t: lista(pick(atitude.t), 3), roll: lista(pick(atitude.Roll), 1), pitch: lista(pick(atitude.Pitch), 1),
      yaw: lista(pick(atitude.Yaw), 1) };
  }
  payload.eventos = eventos.filter((e) => inicio <= e.t && e.t <= fim);
  return payload;
}
