/**
 * Histórico de voos guardado neste navegador (localStorage), com
 * importação do historico_voos.csv do Python e exportação em CSV.
 */
import { useCallback, useEffect, useState } from "react";
import type { RegistroVoo, ValorHistorico } from "./lib/historico";

const CHAVE = "adam.historico.v1";

function ler(): RegistroVoo[] {
  try {
    const t = localStorage.getItem(CHAVE);
    const r = t ? (JSON.parse(t) as RegistroVoo[]) : [];
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

function gravar(r: RegistroVoo[]): string | null {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(r));
    return null;
  } catch (e) {
    return `Não foi possível guardar o histórico neste navegador (${e instanceof Error ? e.message : e}).`;
  }
}

/** Ordem do histórico: pela data do voo (GPS) e, sem data, pelo nome do arquivo (como no Python). */
export function ordenar(r: RegistroVoo[]): RegistroVoo[] {
  return [...r].sort((a, b) => (a.data ?? a.arquivo).localeCompare(b.data ?? b.arquivo) || a.arquivo.localeCompare(b.arquivo));
}

// ---------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------
export function lerCsv(texto: string): string[][] {
  const linhas: string[][] = [];
  let linha: string[] = [], campo = "", aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ",") { linha.push(campo); campo = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      linha.push(campo); campo = "";
      if (linha.some((x) => x !== "")) linhas.push(linha);
      linha = [];
    } else campo += c;
  }
  linha.push(campo);
  if (linha.some((x) => x !== "")) linhas.push(linha);
  return linhas;
}

const celula = (v: unknown) => {
  if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const FIXAS = ["arquivo", "data", "voo", "veredito", "eventos_critico", "eventos_atencao", "eventos_info"] as const;

/** Colunas de métricas na ordem em que aparecem. */
export function colunasDeMetricas(r: RegistroVoo[]): string[] {
  const vistas = new Set<string>();
  for (const x of r) for (const k of Object.keys(x.metricas)) vistas.add(k);
  return [...vistas];
}

export function paraCsv(r: RegistroVoo[]): string {
  const metricas = colunasDeMetricas(r);
  const linhas = [[...FIXAS, ...metricas].join(",")];
  for (const x of ordenar(r)) {
    linhas.push([x.arquivo, x.data, x.voo, x.veredito, x.eventos.critico, x.eventos.atencao, x.eventos.info,
      ...metricas.map((m) => x.metricas[m])].map(celula).join(","));
  }
  return linhas.join("\n") + "\n";
}

/** Linhas de um historico_voos.csv (do Python ou exportado daqui). */
export function deCsv(texto: string, agora = new Date()): RegistroVoo[] {
  const [cab, ...linhas] = lerCsv(texto.replace(/^﻿/, ""));
  if (!cab || !cab.includes("arquivo")) throw new Error("o CSV precisa ter a coluna \"arquivo\" (como o historico_voos.csv).");
  const num = (s: string): ValorHistorico => (s === "" ? null : Number.isFinite(Number(s)) ? Number(s) : s);
  return linhas.map((l) => {
    const v = (c: string) => l[cab.indexOf(c)] ?? "";
    const metricas: Record<string, ValorHistorico> = {};
    cab.forEach((c, i) => { if (!(FIXAS as readonly string[]).includes(c)) metricas[c] = num(l[i] ?? ""); });
    // O Python grava o caminho completo em versões antigas: fica só o nome.
    const arquivo = v("arquivo").split(/[\\/]/).pop() || "(sem nome)";
    const eventos: RegistroVoo["eventos"] = {};
    for (const g of ["critico", "atencao", "info"] as const) if (v(`eventos_${g}`) !== "") eventos[g] = Number(v(`eventos_${g}`));
    return {
      id: `csv|${arquivo}|${v("voo")}`, arquivo, voo: v("voo") ? Number(v("voo")) : null, data: v("data") || null,
      inicio_s: null, fim_s: null, veredito: v("veredito") || null, eventos, metricas, salvo_em: agora.toISOString(), origem: "csv",
    };
  });
}

// ---------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------
export function useHistorico() {
  const [registros, setRegistros] = useState<RegistroVoo[]>(ler);
  const [erro, setErro] = useState<string | null>(null);

  // Outra aba do navegador mudou o histórico: acompanha.
  useEffect(() => {
    const f = (e: StorageEvent) => { if (e.key === CHAVE) setRegistros(ler()); };
    window.addEventListener("storage", f);
    return () => window.removeEventListener("storage", f);
  }, []);

  const atualizar = useCallback((f: (r: RegistroVoo[]) => RegistroVoo[]) => {
    setRegistros((atual) => {
      const novo = f(atual);
      setErro(gravar(novo));
      return novo;
    });
  }, []);

  /** Adiciona os voos de um log (substitui as linhas do mesmo log, se já estavam lá). */
  const salvar = useCallback((novos: RegistroVoo[]) => atualizar((r) => {
    const ids = new Set(novos.map((x) => x.id));
    const prefixos = new Set(novos.map((x) => x.id.split("|").slice(0, 2).join("|")));
    return [...r.filter((x) => !ids.has(x.id) && !prefixos.has(x.id.split("|").slice(0, 2).join("|"))), ...novos];
  }), [atualizar]);
  const remover = useCallback((ids: string[]) => atualizar((r) => r.filter((x) => !ids.includes(x.id))), [atualizar]);
  const limparTudo = useCallback(() => atualizar(() => []), [atualizar]);

  return { registros: ordenar(registros), erro, salvar, remover, limparTudo };
}
