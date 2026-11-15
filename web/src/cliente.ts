/** Conversa com o worker como se fossem funções assíncronas. */
import type { Pedido } from "./worker";
import type { InfoLog, ResultadoVoo } from "./lib/sessao";

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

let proximoId = 1;
const pendentes = new Map<number, {
  ok: (v: unknown) => void; falha: (e: Error) => void; progresso?: (f: number) => void;
}>();

worker.onmessage = (ev: MessageEvent<{ id: number; resultado?: unknown; erro?: string; progresso?: number }>) => {
  const { id, resultado, erro, progresso } = ev.data;
  const p = pendentes.get(id);
  if (!p) return;
  if (progresso !== undefined) { p.progresso?.(progresso); return; }
  pendentes.delete(id);
  if (erro !== undefined) p.falha(new Error(erro));
  else p.ok(resultado);
};

function pedir<T>(pedido: Pedido, progresso?: (f: number) => void): Promise<T> {
  const id = proximoId++;
  return new Promise<T>((ok, falha) => {
    pendentes.set(id, { ok: ok as (v: unknown) => void, falha, progresso });
    worker.postMessage({ id, pedido });
  });
}

export const abrirLog = (arquivo: File, progresso?: (f: number) => void) =>
  pedir<InfoLog>({ tipo: "abrir", arquivo }, progresso);

export const calcularVoo = (inicio: number, fim: number) =>
  pedir<ResultadoVoo>({ tipo: "voo", inicio, fim });

// ---- Consultas das outras abas (log completo) ----
import type { Ficha } from "./lib/ficha";
import type { Painel } from "./lib/dadosVoo";
import type { MensagemTexto, ResultadoSaude } from "./lib/abas/saude";
import type { ResultadoVibracao } from "./lib/abas/vibracao";
import type { ResultadoAero } from "./lib/abas/aerodinamica";
import type { ResultadoEventos } from "./lib/analise/eventos";
import type { Dossie } from "./lib/analise/dossie";

type Args<K extends Pedido["tipo"]> = Omit<Extract<Pedido, { tipo: K }>, "tipo">;
const consultar = <T, K extends Pedido["tipo"]>(tipo: K, args: Args<K>) => pedir<T>({ tipo, ...args } as Pedido);

export const definirFicha = (toml: string) => consultar<Ficha, "ficha">("ficha", { toml });
export const calcularSaude = (a: Args<"saude">) => consultar<ResultadoSaude, "saude">("saude", a);
export const calcularVibracao = (a: Args<"vibracao">) => consultar<ResultadoVibracao, "vibracao">("vibracao", a);
export const calcularAero = (a: Args<"aerodinamica">) => consultar<ResultadoAero | null, "aerodinamica">("aerodinamica", a);
export const calcularReplay = (a: Args<"replay">) => consultar<{
  payload: Record<string, unknown>; barometroRuim: boolean; fonteAltura: "GPS" | "barômetro";
}, "replay">("replay", a);
export const opcoesExplorador = () => consultar<{
  opcoes: string[]; linhas: Record<string, number>; rotulos: Record<string, string>; temParametros: boolean; temMensagens: boolean;
}, "opcoesExplorador">("opcoesExplorador", {});
export const calcularExplorador = (a: Args<"explorador">) => consultar<Painel, "explorador">("explorador", a);
export const tabelaDoTrecho = (a: Args<"tabela">) =>
  consultar<{ colunas: string[]; total: number; linhas: (string | number)[][] }, "tabela">("tabela", a);
export const csvDoTrecho = (a: Args<"csv">) => consultar<string, "csv">("csv", a);
export const parametrosDoLog = () => consultar<{ nome: string; valor: number }[], "parametros">("parametros", {});
export const mensagensDoTrecho = (a: Args<"mensagens">) => consultar<MensagemTexto[] | null, "mensagens">("mensagens", a);
export const eventosDoLog = () => consultar<Omit<ResultadoEventos, "atitude_serie">, "eventos">("eventos", {});
export const dossieDoLog = () => consultar<Dossie, "dossie">("dossie", {});
export const historicoDoLog = () => consultar<import("./lib/historico").RegistroVoo[], "historico">("historico", {});
