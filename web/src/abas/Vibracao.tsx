/** Aba Vibração (porta de visualization/abas/vibracao.py). */
import { useMemo, useState } from "react";
import { calcularVibracao } from "../cliente";
import { ATENCAO, CRITICO } from "../lib/abas/vibracao";
import { fmt } from "../formato";
import { Grafico } from "../componentes/Grafico";
import { Aba, Metricas, PainelDoTrecho, useConsulta, type PropsAba } from "../componentes/comum";

export function AbaVibracao({ info, trecho, onTrecho }: PropsAba) {
  const [fonte, setFonte] = useState<"batch" | "imu">("batch");
  const { dados: r, erro, carregando } = useConsulta(
    () => calcularVibracao({ inicio: trecho[0], fim: trecho[1], fonte }), [info, trecho, fonte]);

  const caixas = useMemo(() => (r?.fases ?? []).map((c) => ({
    type: "box", name: c.fase, x: [c.fase.replace(", ", ",<br>").replace(" / ", " /<br>")], q1: [c.q1], median: [c.mediana], q3: [c.q3],
    lowerfence: [c.inferior], upperfence: [c.superior], hoverinfo: "y+name",
  })), [r]);
  const espectro = useMemo(() => r?.espectro ? ["X", "Y", "Z"].map((nome, k) => ({
    type: "scatter", mode: "lines", name: `Acel. ${nome}`, x: Array.from(r.espectro!.freq), y: Array.from(r.espectro!.eixos[k]),
  })) : [], [r]);
  const mapaCalor = useMemo(() => r?.espectrograma ? [{
    type: "heatmap", x: Array.from(r.espectrograma.t), y: Array.from(r.espectrograma.freq),
    z: r.espectrograma.db.map((l) => Array.from(l)), colorscale: "Viridis", colorbar: { title: { text: "dB" } },
  }] : [], [r]);
  const layoutCaixas = useMemo(() => ({
    showlegend: false, yaxis: { title: { text: "maior eixo (m/s²)" } }, xaxis: { tickangle: 0 },
    shapes: [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: ATENCAO, y1: ATENCAO, line: { dash: "dash", color: "#ffa421" } }],
  }), []);
  const layoutEspectro = useMemo(() => ({
    xaxis: { title: { text: "frequência (Hz)" } }, yaxis: { title: { text: "amplitude (m/s²)" } },
  }), []);
  const layoutCalor = useMemo(() => ({
    xaxis: { title: { text: "tempo (s)" } }, yaxis: { title: { text: "frequência (Hz)" } },
  }), []);

  if (r && !r.metricas && !carregando) {
    return <div className="alerta aviso">Este log não tem mensagens de vibração (VIBE) neste trecho.</div>;
  }
  const m = r?.metricas;
  const pior = m ? Math.max(...Object.values(m.p99)) : 0;
  const situacao = pior < ATENCAO ? "OK" : pior < CRITICO ? "Atenção" : "Crítico";
  const fonteUsada = r?.temBatch ? fonte : "imu";

  return (
    <Aba erro={erro} carregando={carregando} pronto={!!r}>
      {r && m && <>
        {r.temBatch && (
          <div className="controles" role="radiogroup" aria-label="Fonte do espectro">
            <span className="nota">Fonte do espectro:</span>
            {(["batch", "imu"] as const).map((f) => (
              <label key={f} className="opcao">
                <input type="radio" name="fonte-espectro" checked={fonteUsada === f} onChange={() => setFonte(f)} />
                {f === "batch" ? "Batch sampler (alta taxa)" : "Mensagem IMU"}
              </label>
            ))}
          </div>
        )}
        <Metricas itens={[
          ["Situação (99% do tempo)", situacao, "Pelo percentil 99, para não contar picos isolados (toques, pouso)."],
          ["VibeX p99", fmt(m.p99.VibeX, 1, "m/s²")],
          ["VibeY p99", fmt(m.p99.VibeY, 1, "m/s²")],
          ["VibeZ p99", fmt(m.p99.VibeZ, 1, "m/s²")],
          ["Pico (qualquer eixo)", fmt(Math.max(...Object.values(m.max)), 1, "m/s²"), "Picos isolados costumam ser toques/impacto."],
          ["Clipping no trecho", m.clip === null ? null : String(m.clip), "Vezes que o acelerômetro saturou. Em voo deveria ser 0."],
        ]} />
        <p className="nota">Limites do ArduPilot: abaixo de 30 m/s² é bom; 30–60 pode atrapalhar a estimativa de
          posição/altitude; acima de 60 é crítico.</p>

        {r.painel && <PainelDoTrecho dados={r.painel} onTrecho={onTrecho} />}

        <div className="grade2">
          <section>
            <h2 className="subtitulo">Vibração por fase</h2>
            <Grafico titulo="Vibração por fase do voo" dados={caixas} layout={layoutCaixas} />
            <p className="nota">Se a vibração sobe muito de "motor parado" para "motor ligado", a fonte é o motor/hélice
              (balanceamento, fixação, amortecimento da placa).</p>
          </section>
          <section>
            <h2 className="subtitulo">Espectro de frequências</h2>
            {r.espectro ? <>
              <Grafico titulo="Espectro de frequências da vibração" dados={espectro} layout={layoutEspectro} />
              <p className="nota">Fonte: {r.espectro.origem}. Picos principais:{" "}
                {r.espectro.picos.map(([f]) => `${fmt(f, 1)} Hz`).join(", ") || "nenhum pico claro"}. Frequência máxima
                visível: {fmt(r.espectro.taxa / 2, 0)} Hz (metade da taxa de amostragem).</p>
            </> : <div className="alerta aviso">Sem amostras suficientes para o espectro neste trecho.</div>}
          </section>
        </div>

        {r.espectrograma && <>
          <h2 className="subtitulo">Espectrograma (acelerômetro Z ao longo do tempo)</h2>
          <Grafico titulo="Espectrograma do acelerômetro Z" altura={320} dados={mapaCalor} layout={layoutCalor} />
        </>}

        {!r.temBatch && (
          <details className="resumo">
            <summary>Como ver as frequências do motor e da hélice (batch sampler)</summary>
            <p>A mensagem IMU deste log foi gravada a baixa taxa, então o espectro só mostra até a metade dela (veja
              acima) — motor e hélice vibram bem acima disso. Para o próximo voo, ligue o <b>batch sampler</b> do
              ArduPilot, que grava a IMU em alta taxa em lotes:</p>
            <ul>
              <li><code>INS_LOG_BAT_MASK = 1</code> (grava a primeira IMU)</li>
              <li><code>INS_LOG_BAT_OPT = 0</code> (dados antes dos filtros; use 2 para ver depois dos filtros)</li>
              <li>reinicie a controladora</li>
            </ul>
            <p>Esta aba detecta as mensagens ISBH/ISBD automaticamente e passa a usar esses dados no espectro.</p>
          </details>
        )}
      </>}
    </Aba>
  );
}
