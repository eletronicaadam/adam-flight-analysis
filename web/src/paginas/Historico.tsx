/**
 * Histórico de voos (porta de visualization/historico.py): todos os voos
 * já abertos neste navegador, evolução de uma métrica ao longo dos voos,
 * importação/exportação do historico_voos.csv.
 */
import { useMemo, useRef, useState } from "react";
import type { RegistroVoo } from "../lib/historico";
import { deCsv, paraCsv } from "../historicoLocal";
import { baixarArquivo } from "../formato";
import { Grafico } from "../componentes/Grafico";
import { Filtro, contem } from "../componentes/comum";
import {
  CLASSE_VEREDITO, PRINCIPAIS, dataCurta, metricasNumericas, nomeMetrica, rotuloMetrica, valorMetrica,
} from "./metricas";

interface Props {
  registros: RegistroVoo[];
  erro: string | null;
  onSalvar: (r: RegistroVoo[]) => void;
  onRemover: (ids: string[]) => void;
  onLimpar: () => void;
  onComparar: (ids: string[]) => void;
}

export function PaginaHistorico({ registros, erro, onSalvar, onRemover, onLimpar, onComparar }: Props) {
  const [filtro, setFiltro] = useState("");
  const [todas, setTodas] = useState(false);
  const [marcados, setMarcados] = useState<string[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);
  const entrada = useRef<HTMLInputElement>(null);

  const visiveis = registros.filter((r) => contem(r.arquivo, filtro));
  const numericas = useMemo(() => metricasNumericas(registros), [registros]);
  const colunas = todas ? numericas : PRINCIPAIS.filter((k) => numericas.includes(k));
  const [metrica, setMetrica] = useState("bateria_consumo_mah");
  const m = numericas.includes(metrica) ? metrica : numericas[0];

  const evolucao = useMemo(() => {
    const pontos = visiveis.filter((r) => typeof r.metricas[m] === "number");
    return [{
      type: "scatter", mode: "lines+markers", name: nomeMetrica(m),
      x: pontos.map((r) => (r.data ? `${dataCurta(r.data)} · ${r.arquivo}` : r.arquivo)),
      y: pontos.map((r) => r.metricas[m]), hovertemplate: "%{x}<br>%{y}<extra></extra>",
    }];
  }, [visiveis, m]);
  const layoutEvolucao = useMemo(() => ({ xaxis: { automargin: true, tickangle: -30 }, yaxis: { title: { text: rotuloMetrica(m) } } }), [m]);

  const importar = async (f: File) => {
    try {
      const novos = deCsv(await f.text());
      onSalvar(novos);
      setAviso(`${novos.length} voo(s) importado(s) de ${f.name}.`);
    } catch (e) {
      setAviso(`Não foi possível importar ${f.name}: ${e instanceof Error ? e.message : e}`);
    }
  };
  const alternar = (id: string) => setMarcados((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const marcadosValidos = marcados.filter((id) => registros.some((r) => r.id === id));

  return (
    <div className="aba">
      <header className="cabecalho">
        <h1>Histórico de voos</h1>
        <p className="nota">Cada log aberto aqui entra no histórico deste navegador (um registro por voo detectado no
          log). Nada é enviado para servidor; para levar o histórico para outro computador, exporte o CSV e importe lá.</p>
      </header>
      {erro && <div className="alerta erro">{erro}</div>}
      {aviso && <div className="alerta aviso">{aviso}</div>}

      <div className="controles">
        <input ref={entrada} type="file" accept=".csv,text/csv" hidden
               onChange={(e) => { const f = e.target.files?.[0]; if (f) importar(f); e.target.value = ""; }} />
        <button type="button" className="secundario" onClick={() => entrada.current?.click()}
                title="historico_voos.csv gerado pelo exportar_csv.py, ou um CSV exportado daqui">Importar CSV</button>
        <button type="button" className="secundario" disabled={!registros.length}
                onClick={() => baixarArquivo(paraCsv(registros), "historico_voos.csv", "text/csv")}>Exportar CSV</button>
        <button type="button" className="secundario" disabled={marcadosValidos.length < 2}
                onClick={() => onComparar(marcadosValidos)}>Comparar marcados ({marcadosValidos.length})</button>
        <button type="button" className="secundario" disabled={!marcadosValidos.length}
                onClick={() => { onRemover(marcadosValidos); setMarcados([]); }}>Remover marcados</button>
        <button type="button" className="secundario" disabled={!registros.length} onClick={() => {
          if (window.confirm(`Apagar os ${registros.length} voos do histórico deste navegador? Não dá para desfazer.`)) onLimpar();
        }}>Apagar tudo</button>
      </div>

      {!registros.length ? (
        <div className="alerta aviso">Nenhum voo no histórico ainda. Abra um log .bin (barra lateral) ou importe o
          historico_voos.csv do Python.</div>
      ) : <>
        <div className="controles">
          <Filtro valor={filtro} onMudar={setFiltro} placeholder="Filtrar por nome do arquivo" />
          <label className="opcao"><input type="checkbox" checked={todas} onChange={(e) => setTodas(e.target.checked)} />
            Mostrar todas as métricas ({numericas.length})</label>
        </div>
        <h2 className="subtitulo">Todos os voos ({visiveis.length})</h2>
        <div className="rolagem alta">
          <table className="tabela compacta">
            <thead>
              <tr>
                <th><span className="invisivel">Marcar</span></th><th>Voo</th><th>Data</th><th>Veredito</th>
                {colunas.map((k) => <th key={k} title={k}>{rotuloMetrica(k)}</th>)}
              </tr>
            </thead>
            <tbody>
              {visiveis.map((r) => (
                <tr key={r.id}>
                  <td><input type="checkbox" aria-label={`Marcar ${r.arquivo}`} checked={marcados.includes(r.id)} onChange={() => alternar(r.id)} /></td>
                  <td title={r.origem === "csv" ? "Importado de CSV (métricas do log inteiro)" : undefined}>
                    {r.arquivo}{r.origem === "csv" ? " (CSV)" : ""}</td>
                  <td className="num">{dataCurta(r.data)}</td>
                  <td>{r.veredito ? <span className={`selo ${CLASSE_VEREDITO[r.veredito] ?? "sem"}`}>{r.veredito}</span> : "—"}</td>
                  {colunas.map((k) => <td key={k} className="num">{valorMetrica(k, r.metricas[k])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 className="subtitulo">Evolução de uma métrica ao longo dos voos</h2>
        {visiveis.length < 2 ? (
          <div className="nota">Abra mais voos para ver a evolução das métricas ao longo do tempo.</div>
        ) : <>
          <label className="opcao">Métrica
            <select className="campo" value={m} onChange={(e) => setMetrica(e.target.value)}>
              {numericas.map((k) => <option key={k} value={k}>{rotuloMetrica(k)}</option>)}
            </select>
          </label>
          <Grafico titulo={`Evolução de ${nomeMetrica(m)}`} dados={evolucao} layout={layoutEvolucao} />
        </>}
      </>}
    </div>
  );
}
