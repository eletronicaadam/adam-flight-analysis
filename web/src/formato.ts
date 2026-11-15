/** Formatação de números e tempos como no dashboard Python. */
export function mmss(segundos: number): string {
  const s = Math.max(0, segundos);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

/** Valor formatado com `casas` decimais (vírgula decimal) e unidade, ou null se não existir. */
export function fmt(valor: unknown, casas: number, unidade = ""): string | null {
  if (typeof valor !== "number" || !Number.isFinite(valor)) return null;
  const txt = valor.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
  return unidade ? `${txt} ${unidade}` : txt;
}

export function baixarArquivo(conteudo: BlobPart, nome: string, tipo: string) {
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nome;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
