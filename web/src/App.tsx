/**
 * App — barra lateral (arquivo e trecho, que valem para todas as abas) e
 * navegação das abas, como no dashboard.py do Streamlit.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { abrirLog, dossieDoLog, historicoDoLog } from "./cliente";
import { useHistorico } from "./historicoLocal";
import { PaginaHistorico } from "./paginas/Historico";
import { PaginaComparacao } from "./paginas/Comparacao";
import type { InfoLog } from "./lib/sessao";
import type { Ficha } from "./lib/ficha";
import { baixarArquivo, mmss } from "./formato";
import { AbaVoo } from "./abas/Voo";
import { AbaExplorador } from "./abas/Explorador";
import { AbaAerodinamica } from "./abas/Aerodinamica";
import { AbaReplay } from "./abas/Replay";
import { AbaSaude } from "./abas/Saude";
import { AbaVibracao } from "./abas/Vibracao";
import { FichaAeronave } from "./componentes/FichaAeronave";
import type { PropsAba } from "./componentes/comum";
import { SeletorTrecho, trechoValido } from "./componentes/SeletorTrecho";

export type Trecho = [number, number];

const ABAS = ["Voo", "Explorador", "Aerodinâmica", "Replay 3D", "Saúde do sistema", "Vibração"] as const;
type Aba = (typeof ABAS)[number];
const COMPONENTES: Record<Aba, (p: PropsAba) => JSX.Element> = {
  Voo: AbaVoo, Explorador: AbaExplorador, Aerodinâmica: AbaAerodinamica, "Replay 3D": AbaReplay,
  "Saúde do sistema": AbaSaude, Vibração: AbaVibracao,
};

const PAGINAS = [["analise", "Análise do voo"], ["historico", "Histórico"], ["comparacao", "Comparação"]] as const;
type Pagina = (typeof PAGINAS)[number][0];

export function App() {
  const [pagina, setPagina] = useState<Pagina>("analise");
  const historico = useHistorico();
  const [comparar, setComparar] = useState<string[]>([]);
  const [info, setInfo] = useState<InfoLog | null>(null);
  const [lendo, setLendo] = useState<{ nome: string; fracao: number } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [trecho, setTrecho] = useState<Trecho>([0, 0]);
  const [aba, setAba] = useState<Aba>("Voo");
  const [arrastando, setArrastando] = useState(false);
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [versaoFicha, setVersaoFicha] = useState(0);
  const [gerandoDossie, setGerandoDossie] = useState(false);
  const aoMudarFicha = useCallback((f: Ficha) => { setFicha(f); setVersaoFicha((v) => v + 1); }, []);
  const entrada = useRef<HTMLInputElement>(null);

  const abrir = useCallback(async (arquivo: File) => {
    if (!/\.bin$/i.test(arquivo.name)) {
      setErro(`${arquivo.name} não é um log .bin do ArduPilot.`);
      return;
    }
    setErro(null);
    setLendo({ nome: arquivo.name, fracao: 0 });
    try {
      const novo = await abrirLog(arquivo, (fracao) => setLendo({ nome: arquivo.name, fracao }));
      const limite = Math.round((novo.duracao + 0.05) * 10) / 10;
      // Começa pelo trecho em voo; se não detectar, usa o log inteiro.
      const inicial = novo.trechoEmVoo ?? [0, novo.duracao];
      setTrecho(trechoValido(inicial[0], inicial[1], limite));
      setInfo(novo);
      setPagina("analise");
    } catch (e) {
      setErro(`Não foi possível ler ${arquivo.name}: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLendo(null);
    }
  }, []);

  // Cada log aberto entra no histórico deste navegador (e é refeito se a ficha mudar).
  const { salvar } = historico;
  useEffect(() => {
    if (!info || !ficha) return;
    historicoDoLog().then((r) => {
      salvar(r);
      // Os voos do log aberto já ficam escolhidos na comparação.
      setComparar((c) => [...new Set([...c, ...r.map((x) => x.id)])]);
    }).catch(() => { /* o histórico é um extra: não atrapalha a análise */ });
  }, [info, ficha, versaoFicha, salvar]);

  // Arrastar e soltar o .bin em qualquer lugar da página.
  useEffect(() => {
    const sobre = (ev: DragEvent) => {
      if (!ev.dataTransfer?.types.includes("Files")) return;
      ev.preventDefault();
      setArrastando(true);
    };
    const sair = (ev: DragEvent) => { if (!ev.relatedTarget) setArrastando(false); };
    const soltar = (ev: DragEvent) => {
      ev.preventDefault();
      setArrastando(false);
      const f = ev.dataTransfer?.files[0];
      if (f) abrir(f);
    };
    window.addEventListener("dragover", sobre);
    window.addEventListener("dragleave", sair);
    window.addEventListener("drop", soltar);
    return () => {
      window.removeEventListener("dragover", sobre);
      window.removeEventListener("dragleave", sair);
      window.removeEventListener("drop", soltar);
    };
  }, [abrir]);

  const escolher = () => entrada.current?.click();
  const limite = info ? Math.round((info.duracao + 0.05) * 10) / 10 : 0;

  return (
    <div className="layout">
      <aside className="lateral">
        <h1 className="marca">Análise de voo</h1>

        <nav className="paginas" aria-label="Páginas">
          {PAGINAS.map(([p, nome]) => (
            <button key={p} type="button" className={pagina === p ? "ativa" : ""} aria-current={pagina === p ? "page" : undefined}
                    onClick={() => setPagina(p)}>
              {nome}{p === "historico" && historico.registros.length ? ` (${historico.registros.length})` : ""}
            </button>
          ))}
        </nav>

        <section className="bloco">
          <h2>Arquivo de log</h2>
          <input ref={entrada} type="file" accept=".bin,.BIN" hidden
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) abrir(f); e.target.value = ""; }} />
          {info ? (
            <div className="arquivo">
              <div className="arquivo-nome" title={info.nome}>{info.nome}</div>
              <div className="nota">{(info.tamanho / 1e6).toFixed(1)} MB · {mmss(info.duracao)}
                {info.veiculo ? ` · ${info.veiculo}` : ""}</div>
              <button type="button" className="secundario" onClick={escolher} disabled={!!lendo}>Abrir outro log</button>
            </div>
          ) : (
            <button type="button" className="primario largo" onClick={escolher} disabled={!!lendo}>Escolher arquivo .bin</button>
          )}
          <p className="nota">O log é lido no seu navegador: o arquivo não é enviado para nenhum servidor.</p>
        </section>

        {info && (
          <section className="bloco">
            <h2>Dossiê do voo</h2>
            <p className="nota">Eventos de segurança, métricas e o que não é confiável no log inteiro, em JSON (o mesmo
              do <code>analysis/dossie.py</code>, para o agente analista-voo).</p>
            <button type="button" className="secundario" disabled={gerandoDossie} onClick={async () => {
              setGerandoDossie(true);
              try {
                const d = await dossieDoLog();
                baixarArquivo(JSON.stringify(d, null, 2), `${info.nome.replace(/.bin$/i, "")}.json`, "application/json");
              } catch (e) {
                setErro(`Não foi possível gerar o dossiê: ${e instanceof Error ? e.message : e}`);
              } finally {
                setGerandoDossie(false);
              }
            }}>{gerandoDossie ? "Gerando…" : "Baixar dossiê (JSON)"}</button>
          </section>
        )}
        <FichaAeronave ficha={ficha} onFicha={aoMudarFicha} />

        {info && (
          <SeletorTrecho
            chave={`${info.nome}|${info.tamanho}`}
            limite={limite}
            duracao={info.duracao}
            trecho={trecho}
            trechoEmVoo={info.trechoEmVoo}
            onAplicar={setTrecho}
          />
        )}
      </aside>

      <main className="conteudo">
        {lendo && (
          <div className="carregando">
            <div>Lendo <b>{lendo.nome}</b>…</div>
            <progress max={1} value={lendo.fracao} />
          </div>
        )}
        {erro && <div className="alerta erro">{erro}</div>}

        {pagina === "historico" && (
          <PaginaHistorico registros={historico.registros} erro={historico.erro} onSalvar={historico.salvar}
                           onRemover={historico.remover} onLimpar={historico.limparTudo}
                           onComparar={(ids) => { setComparar(ids); setPagina("comparacao"); }} />
        )}
        {pagina === "comparacao" && (
          <PaginaComparacao registros={historico.registros} escolhidos={comparar} onEscolher={setComparar} />
        )}

        {pagina === "analise" && !info && !lendo && (
          <button type="button" className={`soltar ${arrastando ? "ativo" : ""}`} onClick={escolher}>
            <span className="soltar-titulo">Arraste um log .bin do ArduPilot para cá</span>
            <span className="nota">ou clique para escolher o arquivo</span>
          </button>
        )}

        {pagina === "analise" && info && (
          <>
            <header className="cabecalho">
              <h1>Análise de Voo — Adam Aerodesign</h1>
              <p className="nota"><b>{info.nome}</b> · trecho {mmss(trecho[0])} → {mmss(trecho[1])} · altitudes em
                relação ao solo na decolagem</p>
            </header>
            <nav className="abas" role="tablist">
              {ABAS.map((a) => (
                <button key={a} type="button" role="tab" aria-selected={aba === a}
                        className={aba === a ? "ativa" : ""} onClick={() => setAba(a)}>
                  {a}
                </button>
              ))}
            </nav>
            {ficha ? (() => {
              const Componente = COMPONENTES[aba];
              return <Componente key={aba} info={info} trecho={trecho} ficha={ficha} versaoFicha={versaoFicha}
                                 onTrecho={(a, b) => setTrecho(trechoValido(a, b, limite))} />;
            })() : <div className="nota">Carregando a ficha da aeronave…</div>}
          </>
        )}
        {arrastando && info && <div className="soltar-sobreposto">Solte para abrir o log</div>}
      </main>
    </div>
  );
}
