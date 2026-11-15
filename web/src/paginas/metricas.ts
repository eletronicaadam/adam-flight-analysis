/** Nome legível, unidade e casas das métricas do histórico (colunas categoria_chave). */
import type { RegistroVoo } from "../lib/historico";
import { fmt } from "../formato";

export interface InfoMetrica { nome: string; unidade: string; casas: number }

export const METRICAS: Record<string, InfoMetrica> = {
  voo_duracao_s: { nome: "Duração do voo", unidade: "s", casas: 0 },
  gps_distancia_percorrida_m: { nome: "Distância percorrida", unidade: "m", casas: 0 },
  altitude_relativa_solo_maxima_gps_m: { nome: "Altitude máx. (GPS, solo)", unidade: "m", casas: 1 },
  altitude_relativa_solo_maxima_barometro_m: { nome: "Altitude máx. (baro, solo)", unidade: "m", casas: 1 },
  gps_velocidade_maxima_ms: { nome: "Vel. solo máx.", unidade: "m/s", casas: 1 },
  gps_velocidade_media_ms: { nome: "Vel. solo média", unidade: "m/s", casas: 1 },
  bateria_consumo_mah: { nome: "Consumo", unidade: "mAh", casas: 0 },
  bateria_consumo_wh: { nome: "Energia", unidade: "Wh", casas: 1 },
  bateria_tensao_minima_v: { nome: "Tensão mín.", unidade: "V", casas: 2 },
  bateria_tensao_maxima_v: { nome: "Tensão máx.", unidade: "V", casas: 2 },
  bateria_corrente_maxima_a: { nome: "Corrente máx.", unidade: "A", casas: 1 },
  bateria_corrente_media_a: { nome: "Corrente média", unidade: "A", casas: 1 },
  bateria_potencia_maxima_w: { nome: "Potência máx.", unidade: "W", casas: 0 },
  bateria_potencia_media_w: { nome: "Potência média", unidade: "W", casas: 0 },
  altitude_taxa_subida_maxima_ms: { nome: "Subida máx.", unidade: "m/s", casas: 1 },
  altitude_taxa_descida_maxima_ms: { nome: "Descida máx.", unidade: "m/s", casas: 1 },
  vibracao_vibe_x_maxima: { nome: "VibeX máx.", unidade: "m/s²", casas: 1 },
  vibracao_vibe_y_maxima: { nome: "VibeY máx.", unidade: "m/s²", casas: 1 },
  vibracao_vibe_z_maxima: { nome: "VibeZ máx.", unidade: "m/s²", casas: 1 },
  vibracao_vibe_x_media: { nome: "VibeX média", unidade: "m/s²", casas: 1 },
  vibracao_vibe_y_media: { nome: "VibeY média", unidade: "m/s²", casas: 1 },
  vibracao_vibe_z_media: { nome: "VibeZ média", unidade: "m/s²", casas: 1 },
  vibracao_clipping_total: { nome: "Clipping", unidade: "", casas: 0 },
  gps_hdop_medio: { nome: "HDop médio", unidade: "", casas: 2 },
  gps_satelites_media: { nome: "Satélites (média)", unidade: "", casas: 1 },
  gps_percentual_fix_3d: { nome: "Tempo com fix 3D", unidade: "%", casas: 0 },
};

/** Colunas mostradas por padrão na tabela do histórico. */
export const PRINCIPAIS = [
  "voo_duracao_s", "gps_distancia_percorrida_m", "altitude_relativa_solo_maxima_gps_m", "gps_velocidade_maxima_ms",
  "bateria_consumo_mah", "bateria_tensao_minima_v", "bateria_corrente_maxima_a", "vibracao_vibe_z_maxima",
];

export const nomeMetrica = (k: string) => METRICAS[k]?.nome ?? k;
export const rotuloMetrica = (k: string) => (METRICAS[k]?.unidade ? `${nomeMetrica(k)} (${METRICAS[k].unidade})` : nomeMetrica(k));

export function valorMetrica(k: string, v: unknown): string {
  if (typeof v !== "number") return v === null || v === undefined ? "—" : String(v);
  const info = METRICAS[k];
  return fmt(v, info ? info.casas : Number.isInteger(v) ? 0 : 2) ?? "—";
}

/** Colunas numéricas presentes nos registros: as conhecidas primeiro, na ordem acima. */
export function metricasNumericas(r: RegistroVoo[]): string[] {
  const todas = new Set<string>();
  for (const x of r) for (const [k, v] of Object.entries(x.metricas)) if (typeof v === "number") todas.add(k);
  const conhecidas = Object.keys(METRICAS).filter((k) => todas.has(k));
  return [...conhecidas, ...[...todas].filter((k) => !(k in METRICAS)).sort()];
}

export function dataCurta(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export const CLASSE_VEREDITO: Record<string, string> = {
  "problemas críticos": "critico", "atenção": "atencao", "voo normal": "ok", "sem voo detectado": "sem",
};
