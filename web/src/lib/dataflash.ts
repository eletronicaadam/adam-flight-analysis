/**
 * dataflash.ts
 *
 * Leitor de logs DataFlash (.bin) do ArduPilot, equivalente ao parser.py
 * (pymavlink/DFReader). Devolve uma tabela por tipo de mensagem, em
 * colunas: números em Float64Array, textos em string[].
 *
 * Formato do arquivo: cada mensagem começa com 0xA3 0x95 <id>, seguido do
 * corpo com o layout definido por uma mensagem FMT (id 128) anterior. As
 * conversões (centésimos, graus×1e7) são as mesmas do DFReader, para os
 * números saírem idênticos aos do Python.
 */

export interface Mensagem {
  nome: string;
  n: number;
  /** Ordem original das colunas (numéricas e de texto). */
  ordem: string[];
  num: Record<string, Float64Array>;
  txt: Record<string, string[]>;
  /** Colunas inteiras (dtype int no pandas): códigos bBhHiIqQM sem multiplicador. */
  inteiros: string[];
  /** Campos array ("a" = 32 × int16 por linha), achatados: linha k em [32k, 32k+32). */
  arr?: Record<string, Int16Array>;
}

export const TAMANHO_ARRAY = 32;

export type Log = Record<string, Mensagem>;

const CAB1 = 0xa3;
const CAB2 = 0x95;
const ID_FMT = 0x80;

/** Tamanho em bytes e multiplicador de cada código de formato (DFReader.FORMAT_TO_STRUCT). */
const FORMATOS: Record<string, { tam: number; mult: number | null; texto?: boolean; array?: boolean }> = {
  a: { tam: 64, mult: null, array: true },
  b: { tam: 1, mult: null },
  B: { tam: 1, mult: null },
  g: { tam: 2, mult: null },
  h: { tam: 2, mult: null },
  H: { tam: 2, mult: null },
  i: { tam: 4, mult: null },
  I: { tam: 4, mult: null },
  f: { tam: 4, mult: null },
  n: { tam: 4, mult: null, texto: true },
  N: { tam: 16, mult: null, texto: true },
  Z: { tam: 64, mult: null, texto: true },
  c: { tam: 2, mult: 0.01 },
  C: { tam: 2, mult: 0.01 },
  e: { tam: 4, mult: 0.01 },
  E: { tam: 4, mult: 0.01 },
  L: { tam: 4, mult: 1e-7 },
  d: { tam: 8, mult: null },
  M: { tam: 1, mult: null },
  q: { tam: 8, mult: null },
  Q: { tam: 8, mult: null },
};

interface Campo {
  nome: string;
  codigo: string;
  pos: number; // posição no corpo (sem os 3 bytes de cabeçalho)
}

interface Formato {
  id: number;
  nome: string;
  len: number;
  formato: string;
  colunas: string[];
  campos: Campo[] | null; // null = formato que não dá para decodificar
}

function montarFormato(id: number, nome: string, len: number, formato: string, colunasTxt: string): Formato {
  const colunas = colunasTxt === "" ? [] : colunasTxt.split(",");
  const campos: Campo[] = [];
  let pos = 0;
  for (let i = 0; i < formato.length; i++) {
    const info = FORMATOS[formato[i]];
    if (!info) return { id, nome, len, formato, colunas, campos: null };
    if (i < colunas.length) campos.push({ nome: colunas[i], codigo: formato[i], pos });
    pos += info.tam;
  }
  // Corpo maior que a mensagem: não dá para ler.
  if (pos > len - 3) return { id, nome, len, formato, colunas, campos: null };
  return { id, nome, len, formato, colunas, campos };
}

const FMT_PADRAO = montarFormato(ID_FMT, "FMT", 89, "BBnNZ", "Type,Length,Name,Format,Columns");

const decUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Mesma conversão de texto do DFReader: utf-8 (senão latin-1), até o primeiro \0. */
function lerTexto(bytes: Uint8Array, ini: number, tam: number): string {
  let fim = ini;
  const lim = ini + tam;
  let ascii = true;
  while (fim < lim && bytes[fim] !== 0) {
    if (bytes[fim] > 127) ascii = false;
    fim++;
  }
  if (ascii) {
    let s = "";
    for (let k = ini; k < fim; k++) s += String.fromCharCode(bytes[k]);
    return s;
  }
  const fatia = bytes.subarray(ini, fim);
  try {
    return decUtf8.decode(fatia);
  } catch {
    let s = "";
    for (let k = 0; k < fatia.length; k++) s += String.fromCharCode(fatia[k]);
    return s;
  }
}

function float16(v: number): number {
  const sinal = v & 0x8000 ? -1 : 1;
  const exp = (v >> 10) & 0x1f;
  const frac = v & 0x3ff;
  if (exp === 0) return sinal * 2 ** -14 * (frac / 1024);
  if (exp === 31) return frac ? NaN : sinal * Infinity;
  return sinal * 2 ** (exp - 15) * (1 + frac / 1024);
}

/** Lista de inteiros que cresce sem realocar a cada item. */
class ListaU32 {
  dados = new Uint32Array(1024);
  n = 0;
  push(v: number) {
    if (this.n === this.dados.length) {
      const novo = new Uint32Array(this.dados.length * 2);
      novo.set(this.dados);
      this.dados = novo;
    }
    this.dados[this.n++] = v;
  }
}

export interface ProgressoLeitura {
  (fracao: number): void;
}

/**
 * Lê o conteúdo de um .bin. `progresso` recebe de 0 a 1 (a varredura é
 * ~metade do tempo, a decodificação a outra metade).
 */
export function lerLog(buffer: ArrayBuffer, progresso?: ProgressoLeitura): Log {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const total = bytes.length;

  // ---- 1ª passada: posições de cada mensagem, por definição de formato ----
  const formatos = new Map<number, Formato>([[ID_FMT, FMT_PADRAO]]);
  const segmentos: { fmt: Formato; offs: ListaU32 }[] = [];
  const segAtual = new Map<number, { fmt: Formato; offs: ListaU32 }>();
  const segDe = (fmt: Formato) => {
    let s = segAtual.get(fmt.id);
    if (!s || s.fmt !== fmt) {
      s = { fmt, offs: new ListaU32() };
      segAtual.set(fmt.id, s);
      segmentos.push(s);
    }
    return s;
  };

  let i = 0;
  let proximoAviso = 0;
  while (i + 3 <= total) {
    if (bytes[i] !== CAB1 || bytes[i + 1] !== CAB2) {
      i++; // lixo/trecho corrompido: procura o próximo cabeçalho
      continue;
    }
    const id = bytes[i + 2];
    const fmt = formatos.get(id);
    if (!fmt || i + fmt.len > total) {
      i++;
      continue;
    }
    if (id === ID_FMT) {
      const c = i + 3;
      const tipo = bytes[c];
      const len = bytes[c + 1];
      const nome = lerTexto(bytes, c + 2, 4);
      const formato = lerTexto(bytes, c + 6, 16);
      const colunas = lerTexto(bytes, c + 22, 64);
      const atual = formatos.get(tipo);
      if (!atual || atual.nome !== nome || atual.len !== len || atual.formato !== formato ||
          atual.colunas.join(",") !== colunas) {
        if (tipo !== ID_FMT) formatos.set(tipo, montarFormato(tipo, nome, len, formato, colunas));
      }
    }
    if (fmt.campos) segDe(fmt).offs.push(i);
    i += fmt.len;
    if (progresso && i > proximoAviso) {
      progresso((0.5 * i) / total);
      proximoAviso = i + 4_000_000;
    }
  }

  // ---- 2ª passada: decodifica cada segmento em colunas ----
  const partes = new Map<string, Mensagem[]>();
  const totalMsgs = segmentos.reduce((s, g) => s + g.offs.n, 0) || 1;
  let feitas = 0;
  for (const { fmt, offs } of segmentos) {
    // FILE tem conversão especial no DFReader: fica de fora.
    if (!fmt.campos || offs.n === 0 || fmt.nome === "FILE") continue;
    const m = decodificar(bytes, view, fmt, offs.dados.subarray(0, offs.n));
    const lista = partes.get(fmt.nome) ?? [];
    lista.push(m);
    partes.set(fmt.nome, lista);
    feitas += offs.n;
    progresso?.(0.5 + (0.5 * feitas) / totalMsgs);
  }

  const log: Log = {};
  for (const nome of [...partes.keys()].sort()) {
    const lista = partes.get(nome)!;
    log[nome] = lista.length === 1 ? lista[0] : concatenar(nome, lista);
  }
  if (Object.keys(log).length === 0) {
    throw new Error("Nenhuma mensagem foi decodificada. Verifique se o arquivo é um .bin válido do ArduPilot.");
  }
  return log;
}

function decodificar(bytes: Uint8Array, view: DataView, fmt: Formato, offs: Uint32Array): Mensagem {
  const n = offs.length;
  const num: Record<string, Float64Array> = {};
  const txt: Record<string, string[]> = {};
  const ordem: string[] = [];
  const inteiros: string[] = [];
  let arr: Record<string, Int16Array> | undefined;
  for (const campo of fmt.campos!) {
    if (ordem.includes(campo.nome)) continue; // nome repetido: fica o primeiro
    ordem.push(campo.nome);
    const info = FORMATOS[campo.codigo];
    if (info.texto) {
      const col = new Array<string>(n);
      for (let k = 0; k < n; k++) col[k] = lerTexto(bytes, offs[k] + 3 + campo.pos, info.tam);
      txt[campo.nome] = col;
      continue;
    }
    if (info.array) {
      // Igual ao DFReader: array.array("h", bytes) = 32 inteiros de 16 bits.
      const a = new Int16Array(n * TAMANHO_ARRAY);
      const p = 3 + campo.pos;
      for (let k = 0; k < n; k++) {
        for (let j = 0; j < TAMANHO_ARRAY; j++) a[k * TAMANHO_ARRAY + j] = view.getInt16(offs[k] + p + 2 * j, true);
      }
      (arr ??= {})[campo.nome] = a;
      continue;
    }
    if (info.mult === null && "bBhHiIqQM".includes(campo.codigo)) inteiros.push(campo.nome);
    const col = new Float64Array(n);
    const p = 3 + campo.pos;
    switch (campo.codigo) {
      case "b": case "M": for (let k = 0; k < n; k++) col[k] = view.getInt8(offs[k] + p); break;
      case "B": for (let k = 0; k < n; k++) col[k] = bytes[offs[k] + p]; break;
      case "h": case "c": for (let k = 0; k < n; k++) col[k] = view.getInt16(offs[k] + p, true); break;
      case "H": case "C": for (let k = 0; k < n; k++) col[k] = view.getUint16(offs[k] + p, true); break;
      case "i": case "e": case "L": for (let k = 0; k < n; k++) col[k] = view.getInt32(offs[k] + p, true); break;
      case "I": case "E": for (let k = 0; k < n; k++) col[k] = view.getUint32(offs[k] + p, true); break;
      case "f": for (let k = 0; k < n; k++) col[k] = view.getFloat32(offs[k] + p, true); break;
      case "d": for (let k = 0; k < n; k++) col[k] = view.getFloat64(offs[k] + p, true); break;
      case "g": for (let k = 0; k < n; k++) col[k] = float16(view.getUint16(offs[k] + p, true)); break;
      case "q": for (let k = 0; k < n; k++) col[k] = Number(view.getBigInt64(offs[k] + p, true)); break;
      case "Q":
        // Inteiro de 64 bits como dois de 32 (bem mais rápido que BigInt).
        for (let k = 0; k < n; k++) {
          col[k] = view.getUint32(offs[k] + p + 4, true) * 4294967296 + view.getUint32(offs[k] + p, true);
        }
        break;
    }
    const mult = info.mult;
    if (mult !== null) {
      // Igual ao DFReader: dividir por 100/1e7 é mais preciso que multiplicar.
      if (mult > 0 && mult < 1) {
        const div = 1 / mult;
        for (let k = 0; k < n; k++) col[k] = col[k] / div;
      } else {
        for (let k = 0; k < n; k++) col[k] *= mult;
      }
    }
    num[campo.nome] = col;
  }
  return { nome: fmt.nome, n, ordem, num, txt, inteiros, ...(arr ? { arr } : {}) };
}

/** Junta partes de um tipo redefinido no meio do log (colunas que faltam viram NaN/""). */
function concatenar(nome: string, partes: Mensagem[]): Mensagem {
  const n = partes.reduce((s, p) => s + p.n, 0);
  const ordem: string[] = [];
  for (const p of partes) for (const c of p.ordem) if (!ordem.includes(c)) ordem.push(c);
  const ehTexto = (c: string) => partes.some((p) => c in p.txt);
  const num: Record<string, Float64Array> = {};
  const txt: Record<string, string[]> = {};
  const ehArray = (c: string) => partes.some((p) => p.arr && c in p.arr);
  for (const c of ordem) {
    if (ehArray(c)) continue;
    if (ehTexto(c)) {
      const col: string[] = [];
      for (const p of partes) {
        if (c in p.txt) col.push(...p.txt[c]);
        else if (c in p.num) for (const v of p.num[c]) col.push(String(v));
        else for (let k = 0; k < p.n; k++) col.push("");
      }
      txt[c] = col;
    } else {
      const col = new Float64Array(n).fill(NaN);
      let pos = 0;
      for (const p of partes) {
        if (c in p.num) col.set(p.num[c], pos);
        pos += p.n;
      }
      num[c] = col;
    }
  }
  // Inteira só se for inteira em todas as partes (senão o pandas vira float).
  const inteiros = ordem.filter((c) => partes.every((p) => p.inteiros.includes(c)));
  let arr: Record<string, Int16Array> | undefined;
  for (const c of new Set(partes.flatMap((p) => Object.keys(p.arr ?? {})))) {
    const a = new Int16Array(n * TAMANHO_ARRAY);
    let pos = 0;
    for (const p of partes) {
      if (p.arr?.[c]) a.set(p.arr[c], pos * TAMANHO_ARRAY);
      pos += p.n;
    }
    (arr ??= {})[c] = a;
  }
  return { nome, n, ordem, num, txt, inteiros, ...(arr ? { arr } : {}) };
}
