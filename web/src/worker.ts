/// <reference lib="webworker" />
/**
 * Web Worker que lê o .bin e responde às consultas das abas. O log
 * completo fica só aqui (centenas de MB em logs longos); a tela recebe
 * apenas os pacotes já reduzidos.
 */
import { lerLog } from "./lib/dataflash";
import { Sessao } from "./lib/sessao";
import { fichaDoToml, type Ficha } from "./lib/ficha";
import type { ParametrosAero } from "./lib/abas/aerodinamica";
import type { Agrupamento } from "./lib/abas/explorador";

export type Pedido =
  | { tipo: "abrir"; arquivo: File }
  | { tipo: "ficha"; toml: string }
  | { tipo: "voo"; inicio: number; fim: number }
  | { tipo: "saude"; inicio: number; fim: number }
  | { tipo: "vibracao"; inicio: number; fim: number; fonte: "batch" | "imu" }
  | { tipo: "aerodinamica"; inicio: number; fim: number; parametros: ParametrosAero }
  | { tipo: "replay"; inicio: number; fim: number; fonteAltura: "GPS" | "barômetro" | null }
  | { tipo: "opcoesExplorador" }
  | { tipo: "explorador"; inicio: number; fim: number; campos: string[]; agrupamento: Agrupamento; instancia: number; mapa: boolean }
  | { tipo: "tabela"; mensagem: string; inicio: number; fim: number; instancia: number | null }
  | { tipo: "csv"; mensagem: string; inicio: number; fim: number; instancia: number | null }
  | { tipo: "parametros" }
  | { tipo: "mensagens"; inicio: number; fim: number }
  | { tipo: "eventos" }
  | { tipo: "dossie" }
  | { tipo: "historico" }
  | { tipo: "relatorio"; inicio: number; fim: number }
  | { tipo: "csvResumo"; inicio: number; fim: number }
  | { tipo: "csvEventos"; inicio: number; fim: number }
  | { tipo: "zipTrecho"; inicio: number; fim: number };

let sessao: Sessao | null = null;
let ficha: Ficha = fichaDoToml(null);

function exigirSessao(): Sessao {
  if (!sessao) throw new Error("Nenhum log aberto.");
  return sessao;
}

async function atender(p: Pedido, progresso: (f: number) => void): Promise<unknown> {
  switch (p.tipo) {
    case "abrir": {
      sessao = null; // libera o log anterior antes de ler o novo
      const buffer = await p.arquivo.arrayBuffer();
      const log = lerLog(buffer, progresso);
      sessao = new Sessao(log, p.arquivo.name, p.arquivo.size);
      return sessao.info;
    }
    case "ficha":
      ficha = fichaDoToml(p.toml); // erro de sintaxe volta para a tela
      return ficha;
    case "voo": return exigirSessao().voo(p.inicio, p.fim);
    case "saude": return exigirSessao().saude(p.inicio, p.fim);
    case "vibracao": return exigirSessao().vibracao(p.inicio, p.fim, p.fonte);
    case "aerodinamica": return exigirSessao().aerodinamica(p.inicio, p.fim, ficha, p.parametros);
    case "replay": return exigirSessao().replay(p.inicio, p.fim, ficha, p.fonteAltura);
    case "opcoesExplorador": return exigirSessao().opcoesExplorador();
    case "explorador": return exigirSessao().explorador(p.inicio, p.fim, p.campos, p.agrupamento, p.instancia, p.mapa);
    case "tabela": return exigirSessao().tabela(p.mensagem, p.inicio, p.fim, p.instancia);
    case "csv": return exigirSessao().csv(p.mensagem, p.inicio, p.fim, p.instancia);
    case "parametros": return exigirSessao().parametros();
    case "mensagens": return exigirSessao().mensagens(p.inicio, p.fim);
    case "eventos": {
      const { atitude_serie: _, ...r } = exigirSessao().eventos(ficha);
      return r;
    }
    case "dossie": return exigirSessao().dossie(ficha);
    case "historico": return exigirSessao().historico(ficha);
    case "relatorio": return exigirSessao().relatorio(p.inicio, p.fim, ficha);
    case "csvResumo": return exigirSessao().csvResumo(p.inicio, p.fim, ficha);
    case "csvEventos": return exigirSessao().csvEventos(p.inicio, p.fim, ficha);
    case "zipTrecho": return exigirSessao().zipTrecho(p.inicio, p.fim);
  }
}

self.onmessage = async (ev: MessageEvent<{ id: number; pedido: Pedido }>) => {
  const { id, pedido } = ev.data;
  try {
    const resultado = await atender(pedido, (fracao) => self.postMessage({ id, progresso: fracao }));
    self.postMessage({ id, resultado });
  } catch (e) {
    self.postMessage({ id, erro: e instanceof Error ? e.message : String(e) });
  }
};
