/** Peças compartilhadas pelas abas: consulta ao worker, métricas e painel do trecho. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PainelIframe } from "./PainelIframe";

/**
 * Roda uma consulta ao worker sempre que `deps` mudam. Mantém o
 * resultado anterior na tela enquanto recalcula (fica esmaecido) e
 * descarta respostas que chegaram depois de uma consulta mais nova.
 */
export function useConsulta<T>(f: () => Promise<T>, deps: unknown[]) {
  const [dados, setDados] = useState<T | undefined>(undefined);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const fRef = useRef(f);
  fRef.current = f;
  useEffect(() => {
    let atual = true;
    setCarregando(true);
    fRef.current()
      .then((r) => { if (atual) { setDados(r); setErro(null); } })
      .catch((e) => { if (atual) setErro(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (atual) setCarregando(false); });
    return () => { atual = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { dados, erro, carregando };
}

/** Atraso para não recalcular a cada tecla num campo numérico. */
export function useAtrasado<T>(valor: T, ms = 400): T {
  const [v, setV] = useState(valor);
  useEffect(() => {
    const id = setTimeout(() => setV(valor), ms);
    return () => clearTimeout(id);
  }, [valor, ms]);
  return v;
}

export type ItemMetrica = [rotulo: string, valor: string | null | undefined, ajuda?: string];

export function Metricas({ itens }: { itens: ItemMetrica[] }) {
  return (
    <div className="metricas">
      {itens.filter(([, v]) => v !== null && v !== undefined).map(([rotulo, valor, ajuda]) => (
        <div key={rotulo} className="metrica" title={ajuda}>
          <div className="metrica-rotulo">{rotulo}{ajuda && <span className="ajuda" aria-hidden> ⓘ</span>}</div>
          <div className="metrica-valor">{valor}</div>
        </div>
      ))}
    </div>
  );
}

/** Painel de gráficos sincronizados; "Analisar trecho do zoom" muda o trecho de todas as abas. */
export function PainelDoTrecho({ dados, onTrecho }: { dados: unknown; onTrecho: (a: number, b: number) => void }) {
  return (
    <PainelIframe pasta="painel_voo_web" dados={dados} onValor={(v) => {
      const x = v as { acao?: string; inicio?: number; fim?: number };
      if (x?.acao === "janela" && x.inicio !== undefined && x.fim !== undefined) onTrecho(x.inicio, x.fim);
    }} />
  );
}

/** Estado da aba: erro, primeira carga ou conteúdo (esmaecido ao recalcular). */
export function Aba({ erro, carregando, pronto, children, texto = "Calculando…" }:
  { erro: string | null; carregando: boolean; pronto: boolean; children: ReactNode; texto?: string }) {
  if (erro) return <div className="alerta erro">{erro}</div>;
  if (!pronto) return <div className="nota">{texto}</div>;
  return <div className={`aba ${carregando ? "recalculando" : ""}`}>{children}</div>;
}

export function Filtro({ valor, onMudar, placeholder }: { valor: string; onMudar: (v: string) => void; placeholder: string }) {
  return (
    <input className="campo" type="search" value={valor} placeholder={placeholder} aria-label={placeholder}
           onChange={(e) => onMudar(e.target.value)} />
  );
}

export const contem = (texto: string, filtro: string) => !filtro || texto.toLowerCase().includes(filtro.toLowerCase());

/** O que toda aba recebe do App. */
export interface PropsAba {
  info: import("../lib/sessao").InfoLog;
  trecho: [number, number];
  onTrecho: (inicio: number, fim: number) => void;
  ficha: import("../lib/ficha").Ficha;
  /** Muda quando a ficha é salva (para recalcular o que depende dela). */
  versaoFicha: number;
}
