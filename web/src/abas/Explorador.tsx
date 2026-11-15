/**
 * Aba Explorador (porta de visualization/abas/explorador.py): qualquer
 * campo de qualquer mensagem em gráficos sincronizados, tabela/CSV do
 * trecho, parâmetros e mensagens de texto.
 */
import { useEffect, useMemo, useState } from "react";
import {
  calcularExplorador, csvDoTrecho, mensagensDoTrecho, opcoesExplorador, parametrosDoLog, tabelaDoTrecho,
} from "../cliente";
import { MAX_CAMPOS, PADRAO, type Agrupamento } from "../lib/abas/explorador";
import { baixarArquivo } from "../formato";
import { Aba, Filtro, PainelDoTrecho, contem, useConsulta, type PropsAba } from "../componentes/comum";

const AGRUPAMENTOS: [Agrupamento, string][] = [
  ["campo", "Um gráfico por campo"], ["mensagem", "Um gráfico por mensagem"], ["juntos", "Todos juntos"],
];
const LINHAS_NA_TELA = 1000;

function SeletorCampos({ opcoes, rotulos, escolhidos, onMudar }:
  { opcoes: string[]; rotulos: Record<string, string>; escolhidos: string[]; onMudar: (c: string[]) => void }) {
  const [busca, setBusca] = useState("");
  const cheio = escolhidos.length >= MAX_CAMPOS;
  const achados = useMemo(() => {
    if (!busca.trim()) return [];
    const termos = busca.toLowerCase().split(/\s+/).filter(Boolean);
    return opcoes.filter((o) => !escolhidos.includes(o) && termos.every((t) => rotulos[o].toLowerCase().includes(t))).slice(0, 40);
  }, [busca, opcoes, rotulos, escolhidos]);
  return (
    <div className="seletor-campos">
      <div className="fichas-campos">
        {escolhidos.map((c) => (
          <button key={c} type="button" className="ficha-campo" title="Remover" onClick={() => onMudar(escolhidos.filter((x) => x !== c))}>
            {rotulos[c] ?? c} <span aria-hidden>×</span>
          </button>
        ))}
        {!escolhidos.length && <span className="nota">Nenhum campo escolhido.</span>}
      </div>
      <input className="campo" type="search" value={busca} disabled={cheio}
             placeholder={cheio ? `Máximo de ${MAX_CAMPOS} campos` : `Buscar campo (${opcoes.length} no log) — ex.: BAT Curr, VibeZ, XKF4`}
             aria-label="Buscar campo para adicionar" onChange={(e) => setBusca(e.target.value)}
             onKeyDown={(e) => { if (e.key === "Enter" && achados[0]) { onMudar([...escolhidos, achados[0]]); setBusca(""); } }} />
      {achados.length > 0 && (
        <ul className="lista-campos" role="listbox">
          {achados.map((o) => (
            <li key={o}><button type="button" onClick={() => { onMudar([...escolhidos, o]); setBusca(""); }}>{rotulos[o]}</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AbaExplorador({ info, trecho, onTrecho }: PropsAba) {
  const ops = useConsulta(() => opcoesExplorador(), [info]);
  const [campos, setCampos] = useState<string[] | null>(null);
  const [agrupamento, setAgrupamento] = useState<Agrupamento>("campo");
  const [instancia, setInstancia] = useState(0);
  const [mapa, setMapa] = useState(true);
  useEffect(() => { if (ops.dados) setCampos(PADRAO.filter((o) => ops.dados!.opcoes.includes(o))); }, [ops.dados]);

  const escolhidos = campos ?? [];
  const painel = useConsulta(
    () => (campos?.length
      ? calcularExplorador({ inicio: trecho[0], fim: trecho[1], campos, agrupamento, instancia, mapa })
      : Promise.resolve(null)),
    [info, trecho, campos, agrupamento, instancia, mapa]);

  if (!ops.dados) return <Aba erro={ops.erro} carregando pronto={false}>{null}</Aba>;
  const { opcoes, rotulos, linhas } = ops.dados;
  return (
    <div className="aba">
      <SeletorCampos opcoes={opcoes} rotulos={rotulos} escolhidos={escolhidos} onMudar={setCampos} />
      <div className="controles">
        <div role="radiogroup" aria-label="Gráficos" className="controles">
          {AGRUPAMENTOS.map(([v, txt]) => (
            <label key={v} className="opcao">
              <input type="radio" name="agrupamento" checked={agrupamento === v} onChange={() => setAgrupamento(v)} />{txt}
            </label>
          ))}
        </div>
        <label className="opcao" title="Para mensagens com mais de um sensor (GPS 2, IMU 2, núcleo do EKF...)">
          Instância do sensor
          <input className="campo curto" type="number" min={0} max={7} value={instancia}
                 onChange={(e) => setInstancia(Math.max(0, Math.min(7, e.target.valueAsNumber || 0)))} />
        </label>
        <label className="opcao"><input type="checkbox" checked={mapa} onChange={(e) => setMapa(e.target.checked)} />Mostrar mapa</label>
      </div>

      {!escolhidos.length ? <div className="nota">Escolha pelo menos um campo.</div> : (
        <Aba erro={painel.erro} carregando={painel.carregando} pronto={!!painel.dados}>
          {painel.dados && <>
            {!Object.keys(painel.dados.series).length && <div className="alerta aviso">Nenhum dos campos tem dados neste trecho/instância.</div>}
            <PainelDoTrecho dados={painel.dados} onTrecho={onTrecho} />
          </>}
        </Aba>
      )}

      <TabelaDoTrecho info={info} trecho={trecho} instancia={instancia} linhasPorTipo={linhas}
                      tipos={[...new Set(escolhidos.map((o) => o.split(".")[0]))].sort()} />
      {ops.dados.temParametros && <Parametros info={info} />}
      {ops.dados.temMensagens && <Mensagens info={info} trecho={trecho} />}
    </div>
  );
}

function TabelaDoTrecho({ info, trecho, instancia, tipos, linhasPorTipo }: {
  info: PropsAba["info"]; trecho: [number, number]; instancia: number; tipos: string[]; linhasPorTipo: Record<string, number>;
}) {
  const [aberta, setAberta] = useState(false);
  const opcoes = tipos.length ? tipos : Object.keys(linhasPorTipo).sort();
  const [tipo, setTipo] = useState(opcoes[0]);
  const t = opcoes.includes(tipo) ? tipo : opcoes[0];
  const r = useConsulta(
    () => (aberta && t ? tabelaDoTrecho({ mensagem: t, inicio: trecho[0], fim: trecho[1], instancia }) : Promise.resolve(null)),
    [aberta, info, t, trecho, instancia]);
  const baixar = async () => {
    const csv = await csvDoTrecho({ mensagem: t, inicio: trecho[0], fim: trecho[1], instancia });
    baixarArquivo(csv, `${info.nome.replace(/\.bin$/i, "")}_${t}_${trecho[0].toFixed(0)}-${trecho[1].toFixed(0)}s.csv`, "text/csv");
  };
  return (
    <details className="resumo" onToggle={(e) => setAberta((e.target as HTMLDetailsElement).open)}>
      <summary>Tabela de dados do trecho (e download em CSV)</summary>
      <div className="controles">
        <label className="opcao">Mensagem
          <select className="campo" value={t} onChange={(e) => setTipo(e.target.value)}>
            {opcoes.map((o) => <option key={o} value={o}>{o} ({linhasPorTipo[o] ?? 0} linhas no log)</option>)}
          </select>
        </label>
        <button type="button" className="secundario" onClick={baixar} disabled={!r.dados?.total}>Baixar CSV do trecho</button>
      </div>
      {r.dados && <>
        <p className="nota">{r.dados.total} linhas no trecho
          {r.dados.total > LINHAS_NA_TELA ? ` — mostrando as primeiras ${LINHAS_NA_TELA} (o CSV tem todas)` : ""}</p>
        <div className="rolagem alta">
          <table className="tabela compacta">
            <thead><tr>{r.dados.colunas.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {r.dados.linhas.slice(0, LINHAS_NA_TELA).map((l, i) => (
                <tr key={i}>{l.map((v, k) => <td key={k} className={typeof v === "number" ? "num" : ""}>
                  {typeof v === "number" ? (Number.isNaN(v) ? "" : String(v)) : v}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </>}
    </details>
  );
}

function Parametros({ info }: { info: PropsAba["info"] }) {
  const [aberta, setAberta] = useState(false);
  const [busca, setBusca] = useState("");
  const r = useConsulta(() => (aberta ? parametrosDoLog() : Promise.resolve(null)), [aberta, info]);
  return (
    <details className="resumo" onToggle={(e) => setAberta((e.target as HTMLDetailsElement).open)}>
      <summary>Parâmetros da controladora (PARM)</summary>
      <Filtro valor={busca} onMudar={setBusca} placeholder="Buscar parâmetro (ex.: BATT, AHRS, ARSPD)" />
      <div className="rolagem alta">
        <table className="tabela compacta">
          <thead><tr><th>parâmetro</th><th>valor</th></tr></thead>
          <tbody>
            {(r.dados ?? []).filter((p) => contem(p.nome, busca)).map((p) => (
              <tr key={p.nome}><td>{p.nome}</td><td className="num">{String(p.valor)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Mensagens({ info, trecho }: { info: PropsAba["info"]; trecho: [number, number] }) {
  const [aberta, setAberta] = useState(false);
  const [filtro, setFiltro] = useState("");
  const r = useConsulta(() => (aberta ? mensagensDoTrecho({ inicio: trecho[0], fim: trecho[1] }) : Promise.resolve(null)),
    [aberta, info, trecho]);
  return (
    <details className="resumo" onToggle={(e) => setAberta((e.target as HTMLDetailsElement).open)}>
      <summary>Mensagens de texto do log (MSG)</summary>
      <Filtro valor={filtro} onMudar={setFiltro} placeholder="Filtrar texto (ex.: EKF, failsafe)" />
      <div className="rolagem alta">
        <table className="tabela compacta">
          <thead><tr><th>instante</th><th>mensagem</th></tr></thead>
          <tbody>
            {(r.dados ?? []).filter((m) => contem(m.mensagem, filtro)).map((m, i) => (
              <tr key={i}><td className="num">{m.instante}</td><td>{m.mensagem}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
