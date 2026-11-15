/**
 * Comparação entre voos (porta de visualization/comparacao.py): tabela
 * lado a lado e gráfico de barras de uma métrica.
 */
import { useMemo, useState } from "react";
import type { RegistroVoo } from "../lib/historico";
import { Grafico } from "../componentes/Grafico";
import {
  CLASSE_VEREDITO, METRICAS, dataCurta, metricasNumericas, nomeMetrica, rotuloMetrica, valorMetrica,
} from "./metricas";

interface Props {
  registros: RegistroVoo[];
  escolhidos: string[];
  onEscolher: (ids: string[]) => void;
}

export function PaginaComparacao({ registros, escolhidos, onEscolher }: Props) {
  const sel = registros.filter((r) => escolhidos.includes(r.id));
  const numericas = useMemo(() => metricasNumericas(sel), [sel]);
  const [metrica, setMetrica] = useState("bateria_consumo_mah");
  const [soConhecidas, setSoConhecidas] = useState(true);
  const m = numericas.includes(metrica) ? metrica : numericas[0];
  const linhas = soConhecidas ? numericas.filter((k) => k in METRICAS) : numericas;

  const barras = useMemo(() => [{
    type: "bar", x: sel.map((r) => r.arquivo), y: sel.map((r) => r.metricas[m]), marker: { color: "#e8590c" },
    hovertemplate: "%{x}<br>%{y}<extra></extra>",
  }], [sel, m]);
  const layoutBarras = useMemo(() => ({ xaxis: { automargin: true }, yaxis: { title: { text: rotuloMetrica(m) } } }), [m]);

  const alternar = (id: string) => onEscolher(escolhidos.includes(id) ? escolhidos.filter((x) => x !== id) : [...escolhidos, id]);

  return (
    <div className="aba">
      <header className="cabecalho">
        <h1>Comparação entre voos</h1>
        <p className="nota">Escolha 2 ou mais voos do histórico deste navegador.</p>
      </header>
      {registros.length < 2 ? (
        <div className="alerta aviso">O histórico tem {registros.length} voo(s). Abra mais logs ou importe um CSV na página
          Histórico para comparar.</div>
      ) : <>
        <fieldset className="escolha-voos">
          <legend>Voos</legend>
          {registros.map((r) => (
            <label key={r.id} className="opcao">
              <input type="checkbox" checked={escolhidos.includes(r.id)} onChange={() => alternar(r.id)} />
              {r.arquivo}{r.data ? ` (${dataCurta(r.data)})` : ""}{r.origem === "csv" ? " · CSV" : ""}
            </label>
          ))}
        </fieldset>

        {sel.length < 2 ? <div className="nota">Escolha pelo menos 2 voos para comparar.</div> : <>
          <h2 className="subtitulo">Tabela comparativa</h2>
          <label className="opcao"><input type="checkbox" checked={!soConhecidas} onChange={(e) => setSoConhecidas(!e.target.checked)} />
            Mostrar todas as métricas</label>
          <div className="rolagem">
            <table className="tabela compacta">
              <thead>
                <tr><th>Métrica</th>{sel.map((r) => <th key={r.id}>{r.arquivo}</th>)}</tr>
              </thead>
              <tbody>
                <tr><td>Data</td>{sel.map((r) => <td key={r.id} className="num">{dataCurta(r.data)}</td>)}</tr>
                <tr><td>Veredito</td>{sel.map((r) => (
                  <td key={r.id}>{r.veredito ? <span className={`selo ${CLASSE_VEREDITO[r.veredito] ?? "sem"}`}>{r.veredito}</span> : "—"}</td>
                ))}</tr>
                <tr><td>Eventos críticos / atenção</td>{sel.map((r) => (
                  <td key={r.id} className="num">{r.eventos.critico ?? "—"} / {r.eventos.atencao ?? "—"}</td>
                ))}</tr>
                {linhas.map((k) => {
                  const vals = sel.map((r) => r.metricas[k]).filter((v): v is number => typeof v === "number");
                  const maior = vals.length > 1 ? Math.max(...vals) : NaN, menor = vals.length > 1 ? Math.min(...vals) : NaN;
                  return (
                    <tr key={k}>
                      <td title={k}>{rotuloMetrica(k)}</td>
                      {sel.map((r) => {
                        const v = r.metricas[k];
                        const marca = typeof v === "number" && maior !== menor ? (v === maior ? "maior" : v === menor ? "menor" : "") : "";
                        return <td key={r.id} className={`num ${marca}`} title={marca ? `${marca} valor` : undefined}>{valorMetrica(k, v)}</td>;
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="nota">Negrito = maior valor da linha; sublinhado = menor.</p>

          <h2 className="subtitulo">Comparação de uma métrica</h2>
          <label className="opcao">Métrica
            <select className="campo" value={m} onChange={(e) => setMetrica(e.target.value)}>
              {numericas.map((k) => <option key={k} value={k}>{rotuloMetrica(k)}</option>)}
            </select>
          </label>
          <Grafico titulo={`${nomeMetrica(m)} por voo`} dados={barras} layout={layoutBarras} />
        </>}
      </>}
    </div>
  );
}
