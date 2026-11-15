/** Exportações do log aberto: relatório PDF, CSVs do trecho e dossiê JSON. */
import { useState } from "react";
import { csvEventosDoTrecho, csvResumoDoTrecho, dadosDoRelatorio, dossieDoLog, zipDoTrecho } from "../cliente";
import type { InfoLog } from "../lib/sessao";
import { baixarArquivo, mmss } from "../formato";

interface Props { info: InfoLog; trecho: [number, number] }

export function Exportar({ info, trecho }: Props) {
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const base = info.nome.replace(/\.bin$/i, "");
  const sufixo = `${trecho[0].toFixed(0)}-${trecho[1].toFixed(0)}s`;
  const [inicio, fim] = trecho;

  const acao = (nome: string, f: () => Promise<void>) => async () => {
    setOcupado(nome);
    setErro(null);
    try { await f(); } catch (e) { setErro(`${nome}: ${e instanceof Error ? e.message : e}`); } finally { setOcupado(null); }
  };

  const itens: [string, string, () => Promise<void>][] = [
    ["Relatório PDF", "Veredito, eventos, métricas, gráficos e trajeto do trecho", async () => {
      const [dados, { gerarRelatorioPdf }] = await Promise.all([dadosDoRelatorio({ inicio, fim }), import("../relatorioPdf")]);
      baixarArquivo(gerarRelatorioPdf(dados), `${base}_relatorio_${sufixo}.pdf`, "application/pdf");
    }],
    ["Resumo (CSV)", "Uma linha com as métricas do trecho, nas colunas do historico_voos.csv", async () => {
      baixarArquivo(await csvResumoDoTrecho({ inicio, fim }), `${base}_resumo_${sufixo}.csv`, "text/csv");
    }],
    ["Eventos (CSV)", "Eventos de segurança do trecho, com a evidência", async () => {
      baixarArquivo(await csvEventosDoTrecho({ inicio, fim }), `${base}_eventos_${sufixo}.csv`, "text/csv");
    }],
    ["Todas as mensagens (ZIP)", "Um CSV por tipo de mensagem (GPS, BAT, IMU...) com as linhas do trecho. No log inteiro pode passar de 100 MB e levar ~15 s.", async () => {
      baixarArquivo(await zipDoTrecho({ inicio, fim }) as BlobPart, `${base}_mensagens_${sufixo}.zip`, "application/zip");
    }],
    ["Dossiê (JSON)", "Log inteiro, para o agente analista-voo (mesmo do analysis/dossie.py)", async () => {
      baixarArquivo(JSON.stringify(await dossieDoLog(), null, 2), `${base}.json`, "application/json");
    }],
  ];

  return (
    <section className="bloco">
      <h2>Exportar</h2>
      <p className="nota">Do trecho {mmss(inicio)} → {mmss(fim)} (o dossiê é do log inteiro).</p>
      <div className="exportar">
        {itens.map(([nome, ajuda, f]) => (
          <button key={nome} type="button" className="secundario" title={ajuda} disabled={!!ocupado} onClick={acao(nome, f)}>
            {ocupado === nome ? "Gerando…" : nome}
          </button>
        ))}
      </div>
      {erro && <p className="alerta erro">{erro}</p>}
    </section>
  );
}
