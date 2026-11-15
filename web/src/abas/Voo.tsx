/**
 * Aba Voo — métricas do trecho, painel com mapa e gráficos de
 * velocidade/altitude/bateria, KML do trajeto e resumo completo
 * (porta de visualization/abas/voo.py).
 */
import { useEffect, useState } from "react";
import { calcularVoo } from "../cliente";
import type { InfoLog, ResultadoVoo } from "../lib/sessao";
import type { Painel } from "../lib/dadosVoo";
import { baixarArquivo, fmt, mmss } from "../formato";
import { PainelIframe } from "../componentes/PainelIframe";
import type { Trecho } from "../App";
import type { PropsAba } from "../componentes/comum";

interface Props {
  info: InfoLog;
  trecho: Trecho;
  onTrecho: (inicio: number, fim: number) => void;
}

function maximoDaSerie(painel: Painel, chave: string): number | null {
  const s = painel.series[chave];
  if (!s) return null;
  let m: number | null = null;
  for (const v of s.y) if (v !== null && (m === null || v > m)) m = v;
  return m;
}

export function AbaVoo({ info, trecho, onTrecho }: Props & Partial<PropsAba>) {
  const [r, setR] = useState<ResultadoVoo | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [calculando, setCalculando] = useState(false);

  useEffect(() => {
    let atual = true;
    setCalculando(true);
    calcularVoo(trecho[0], trecho[1])
      .then((res) => { if (atual) { setR(res); setErro(null); } })
      .catch((e) => { if (atual) setErro(String(e.message ?? e)); })
      .finally(() => { if (atual) setCalculando(false); });
    return () => { atual = false; };
  }, [info, trecho]);

  if (erro) return <div className="alerta erro">{erro}</div>;
  if (!r) return <div className="nota">Preparando o trecho…</div>;

  const { painel, resumo, kml } = r;
  const gps = (resumo.gps ?? {}) as Record<string, number>;
  const bat = (resumo.bateria ?? {}) as Record<string, number>;
  const metricas: [string, string | null][] = [
    ["Duração do trecho", mmss(trecho[1] - trecho[0])],
    ["Distância", fmt(gps.distancia_percorrida_m, 0, "m")],
    ["Alt. máx. (baro)", fmt(maximoDaSerie(painel, "altitude"), 1, "m")],
    ["Alt. máx. (GPS)", fmt(maximoDaSerie(painel, "altitude_gps"), 1, "m")],
    ["Vel. solo máx.", fmt(gps.velocidade_maxima_ms, 1, "m/s")],
    ["Vel. ar máx.", fmt(maximoDaSerie(painel, "vel_ar"), 1, "m/s")],
    ["Consumo", fmt(bat.consumo_mah, 0, "mAh")],
    ["Energia", fmt(bat.consumo_wh, 1, "Wh")],
    ["Tensão mín.", fmt(bat.tensao_minima_v, 2, "V")],
    ["Corrente máx.", fmt(bat.corrente_maxima_a, 1, "A")],
    ["Potência máx.", fmt(bat.potencia_maxima_w, 0, "W")],
  ];
  const erros = Object.entries(resumo)
    .filter(([, v]) => "erro" in v)
    .map(([k, v]) => `${k}: ${(v as { erro: string }).erro}`);

  const baseNome = info.nome.replace(/\.bin$/i, "");

  return (
    <div className={`aba ${calculando ? "recalculando" : ""}`}>
      <div className="metricas">
        {metricas.filter(([, v]) => v !== null).map(([rotulo, valor]) => (
          <div key={rotulo} className="metrica">
            <div className="metrica-rotulo">{rotulo}</div>
            <div className="metrica-valor">{valor}</div>
          </div>
        ))}
      </div>
      {erros.length > 0 && <p className="nota">Não calculado neste trecho — {erros.join(" · ")}</p>}
      {painel.avisos.map((a) => <div key={a} className="alerta aviso">{a}</div>)}

      <PainelIframe
        pasta="painel_voo_web"
        dados={painel}
        onValor={(v) => {
          const x = v as { acao?: string; inicio?: number; fim?: number };
          if (x?.acao === "janela" && x.inicio !== undefined && x.fim !== undefined) onTrecho(x.inicio, x.fim);
        }}
      />

      <div className="acoes">
        {kml && (
          <button type="button" className="secundario" title="Abra no Google Earth ou importe no Google My Maps"
                  onClick={() => baixarArquivo(kml, `${baseNome}_${trecho[0].toFixed(0)}-${trecho[1].toFixed(0)}s.kml`,
                    "application/vnd.google-earth.kml+xml")}>
            Baixar trajeto (KML)
          </button>
        )}
      </div>

      <details className="resumo">
        <summary>Resumo completo do trecho</summary>
        {Object.entries(resumo).map(([cat, valores]) => (
          <div key={cat}>
            <h3>{cat[0].toUpperCase() + cat.slice(1)}</h3>
            <table>
              <thead><tr><th>métrica</th><th>valor</th></tr></thead>
              <tbody>
                {Object.entries(valores).map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td>{typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </details>
    </div>
  );
}
