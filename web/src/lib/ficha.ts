/**
 * ficha.ts — ficha da aeronave (porta de analysis/ficha.py): massa, asa,
 * bateria, propulsão e como a controladora está instalada. No site ela é
 * editável e fica guardada no navegador; o padrão é o aeronave.toml do
 * repositório.
 */

export interface Ficha {
  nome: string | null;
  massa_vazio_kg: number | null;
  massa_decolagem_kg: number | null;
  area_asa_m2: number | null;
  envergadura_m: number | null;
  bateria: { celulas: number | null; capacidade_mah: number | null; tensao_minima_celula_v: number | null };
  controladora: { funcao: string; orientacao: string; calibrada: boolean };
  propulsao: { motor: string | null; helice: string | null; corrente_maxima_a: number | null };
  [extra: string]: unknown;
}

type Valor = string | number | boolean | null | Tabela;
interface Tabela { [k: string]: Valor }

export const PADRAO: Tabela = {
  nome: "",
  massa_vazio_kg: null,
  massa_decolagem_kg: null,
  area_asa_m2: null,
  envergadura_m: null,
  bateria: { celulas: null, capacidade_mah: null, tensao_minima_celula_v: 3.3 },
  controladora: { funcao: "piloto_automatico", orientacao: "normal", calibrada: true },
  propulsao: { motor: "", helice: "", corrente_maxima_a: null },
};

const ehTabela = (v: unknown): v is Tabela => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------
// TOML (o subconjunto que a ficha usa: [tabelas], textos, números,
// booleanos e comentários)
// ---------------------------------------------------------------------
function semComentario(linha: string): string {
  let dentro: string | null = null;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (dentro) {
      if (c === "\\" && dentro === '"') i++;
      else if (c === dentro) dentro = null;
    } else if (c === '"' || c === "'") dentro = c;
    else if (c === "#") return linha.slice(0, i);
  }
  return linha;
}

function lerValor(texto: string, nLinha: number): Valor {
  const t = texto.trim();
  if (t.startsWith('"')) {
    if (!t.endsWith('"') || t.length < 2) throw new Error(`linha ${nLinha}: texto sem aspas de fechamento`);
    return JSON.parse(t) as string;
  }
  if (t.startsWith("'")) {
    if (!t.endsWith("'") || t.length < 2) throw new Error(`linha ${nLinha}: texto sem aspas de fechamento`);
    return t.slice(1, -1);
  }
  if (t === "true") return true;
  if (t === "false") return false;
  const n = Number(t.replace(/_/g, ""));
  if (t !== "" && Number.isFinite(n)) return n;
  throw new Error(`linha ${nLinha}: valor não entendido: ${t}`);
}

export function lerToml(texto: string): Tabela {
  const raiz: Tabela = {};
  let atual = raiz;
  texto.split(/\r?\n/).forEach((bruta, i) => {
    const linha = semComentario(bruta).trim();
    if (!linha) return;
    const tabela = /^\[\s*([A-Za-z0-9_.-]+)\s*\]$/.exec(linha);
    if (tabela) {
      atual = raiz;
      for (const parte of tabela[1].split(".")) {
        if (!ehTabela(atual[parte])) atual[parte] = {};
        atual = atual[parte] as Tabela;
      }
      return;
    }
    const igual = linha.indexOf("=");
    if (igual < 1) throw new Error(`linha ${i + 1}: esperado "chave = valor"`);
    const chave = linha.slice(0, igual).trim().replace(/^"(.*)"$/, "$1");
    atual[chave] = lerValor(linha.slice(igual + 1), i + 1);
  });
  return raiz;
}

// ---------------------------------------------------------------------
// Ficha
// ---------------------------------------------------------------------
function mesclar(base: Tabela, novo: Tabela): Tabela {
  const r: Tabela = { ...base };
  for (const [k, v] of Object.entries(novo)) {
    r[k] = ehTabela(v) && ehTabela(base[k]) ? mesclar(base[k] as Tabela, v) : v;
  }
  return r;
}

function copiar(t: Tabela): Tabela {
  return JSON.parse(JSON.stringify(t)) as Tabela;
}

/**
 * Ficha a partir do texto TOML (vazio = só os padrões). Como no Python,
 * campos numéricos 0 ou textos vazios viram null ("não informado"), e
 * textos com padrão voltam ao padrão.
 */
export function fichaDoToml(texto: string | null): Ficha {
  const ficha = texto ? mesclar(copiar(PADRAO), lerToml(texto)) : copiar(PADRAO);
  const limpar = (d: Tabela) => {
    for (const [k, v] of Object.entries(d)) {
      if (ehTabela(v)) limpar(v);
      else if (typeof v === "number" && v === 0) d[k] = null;
      else if (v === "") d[k] = null;
    }
  };
  const preencher = (d: Tabela, padrao: Tabela) => {
    for (const [k, v] of Object.entries(padrao)) {
      if (ehTabela(v) && ehTabela(d[k])) preencher(d[k] as Tabela, v);
      else if ((d[k] === null || d[k] === undefined) && v !== null && v !== "") d[k] = v;
    }
  };
  limpar(ficha);
  preencher(ficha, PADRAO);
  return ficha as unknown as Ficha;
}

/** True se a controladora comanda os servos (modos/failsafes importam). */
export const controladoraComanda = (ficha: Ficha) => ficha.controladora.funcao !== "registrador";
