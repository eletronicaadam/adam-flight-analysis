/**
 * explorador.ts — cálculos da aba Explorador (porta de
 * visualization/abas/explorador.py): qualquer campo de qualquer mensagem
 * em gráficos sincronizados, tabela/CSV do trecho, parâmetros e mensagens.
 */
import type { Log } from "../dataflash";
import { colunaDeInstancia, montarPainelPersonalizado, segundos, type LinhaPainel, type SpecSerie, type Unidades } from "../dadosVoo";
import { pyRound } from "../numerico";

export const MAX_CAMPOS = 12;
export const PADRAO = ["GPS.Spd", "GPS.Alt", "BAT.Curr", "VIBE.VibeZ"];
export type Agrupamento = "campo" | "mensagem" | "juntos";

/** Todos os campos numéricos com tempo ("GPS.Spd", ...) e as linhas de cada tipo. */
export function opcoes(dados: Log) {
  const lista: string[] = [];
  const linhas: Record<string, number> = {};
  for (const tipo of Object.keys(dados).sort()) {
    const m = dados[tipo];
    if (!m.num.TimeUS || !m.n) continue;
    linhas[tipo] = m.n;
    const inst = colunaDeInstancia(m);
    for (const c of m.ordem) if (c !== "TimeUS" && c !== inst && c in m.num) lista.push(`${tipo}.${c}`);
  }
  return { opcoes: lista, linhas };
}

export function rotulo(opcao: string, un: Unidades): string {
  const [tipo, campo] = opcao.split(".", 2);
  const u = un[tipo]?.[campo]?.[0] ?? "";
  return u ? `${opcao} (${u})` : opcao;
}

export function painelExplorador(dados: Log, origem: number, un: Unidades, inicio: number, fim: number, campos: string[],
                                 agrupamento: Agrupamento, instancia: number, mapa: boolean) {
  const specs: [string, SpecSerie][] = campos.map((opcao) => {
    const [tipo, campo] = opcao.split(".", 2);
    const [unidade, fator] = un[tipo]?.[campo] ?? ["", 1.0];
    return [tipo, { tipo, campo, nome: opcao, unidade, fator, instancia }];
  });
  let linhas: LinhaPainel[];
  if (agrupamento === "campo") {
    linhas = specs.map(([, s]) => ({ titulo: rotulo(s.nome, un), series: [s] }));
  } else if (agrupamento === "mensagem") {
    const grupos = new Map<string, SpecSerie[]>();
    for (const [tipo, s] of specs) grupos.set(tipo, [...(grupos.get(tipo) ?? []), s]);
    linhas = [...grupos].map(([titulo, series]) => ({ titulo, series }));
  } else {
    linhas = [{ titulo: "Campos selecionados", series: specs.map(([, s]) => s) }];
  }
  return montarPainelPersonalizado(dados, origem, inicio, fim, linhas, mapa);
}

/** Linhas de uma mensagem no trecho (instância pedida), com t_s no lugar de TimeUS. */
export function tabela(dados: Log, origem: number, tipo: string, inicio: number, fim: number, instancia: number | null) {
  const m = dados[tipo];
  const t = segundos(m, origem);
  const c = colunaDeInstancia(m);
  const idx: number[] = [];
  for (let i = 0; i < m.n; i++) {
    if (t[i] >= inicio && t[i] <= fim && (c === null || instancia === null || m.num[c][i] === instancia)) idx.push(i);
  }
  const colunas = [...m.ordem.filter((x) => x !== "TimeUS" && (x in m.num || x in m.txt)), "t_s"];
  const valor = (x: string, i: number): string | number =>
    x === "t_s" ? pyRound(t[i], 3) : x in m.num ? m.num[x][i] : m.txt[x][i];
  return { colunas, idx, valor };
}

function celulaCsv(v: string | number): string {
  if (typeof v === "number") return Number.isNaN(v) ? "" : String(v);
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function tabelaDoTrecho(dados: Log, origem: number, tipo: string, inicio: number, fim: number, instancia: number | null,
                               maxLinhas = 5000) {
  const { colunas, idx, valor } = tabela(dados, origem, tipo, inicio, fim, instancia);
  return { colunas, total: idx.length, linhas: idx.slice(0, maxLinhas).map((i) => colunas.map((c) => valor(c, i))) };
}

export function csvDoTrecho(dados: Log, origem: number, tipo: string, inicio: number, fim: number, instancia: number | null): string {
  const { colunas, idx, valor } = tabela(dados, origem, tipo, inicio, fim, instancia);
  const partes = [colunas.join(",")];
  for (const i of idx) partes.push(colunas.map((c) => celulaCsv(valor(c, i))).join(","));
  return partes.join("\n") + "\n";
}

/** Parâmetros da controladora: último valor de cada nome, na ordem do log. */
export function parametrosOrdenados(dados: Log): { nome: string; valor: number }[] {
  const parm = dados.PARM;
  if (!parm || !parm.txt.Name) return [];
  const ultima = new Map<string, number>();
  parm.txt.Name.forEach((n, i) => ultima.set(n, i));
  return [...ultima.entries()].sort((a, b) => a[1] - b[1]).map(([nome, i]) => ({ nome, valor: parm.num.Value[i] }));
}
