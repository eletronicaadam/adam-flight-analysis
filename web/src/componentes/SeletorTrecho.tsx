/** Escolha do trecho de tempo (vale para todas as abas). */
import { useEffect, useState } from "react";
import { mmss } from "../formato";
import type { Trecho } from "../App";

const TRECHO_MINIMO_S = 1.0;
const r1 = (x: number) => Math.round(x * 10) / 10;

/** Ordena, limita a [0, limite] e garante a duração mínima (igual ao dashboard.py). */
export function trechoValido(inicio: number, fim: number, limite: number): Trecho {
  let [a, b] = [inicio, fim].sort((x, y) => x - y);
  a = Math.max(0, a);
  b = Math.min(limite, b);
  if (b - a < TRECHO_MINIMO_S) {
    const meio = (a + b) / 2;
    a = Math.max(0, Math.min(meio - TRECHO_MINIMO_S / 2, limite - TRECHO_MINIMO_S));
    b = Math.min(limite, a + TRECHO_MINIMO_S);
  }
  return [r1(a), r1(b)];
}

interface Props {
  chave: string;
  limite: number;
  duracao: number;
  trecho: Trecho;
  trechoEmVoo: [number, number] | null;
  onAplicar: (t: Trecho) => void;
}

export function SeletorTrecho({ chave, limite, duracao, trecho, trechoEmVoo, onAplicar }: Props) {
  // Rascunho: mover o controle não recalcula nada até clicar em "Aplicar".
  const [rasc, setRasc] = useState<Trecho>(trecho);
  useEffect(() => setRasc(trecho), [trecho, chave]);

  const [a, b] = rasc;
  const curto = b - a < TRECHO_MINIMO_S;
  const mudou = a !== trecho[0] || b !== trecho[1];
  const aplicar = (t: Trecho) => onAplicar(trechoValido(t[0], t[1], limite));
  const pct = (x: number) => (100 * x) / Math.max(limite, 1e-9);

  return (
    <section className="bloco">
      <h2>Trecho a analisar</h2>
      <div className="duplo" style={{ "--a": `${pct(a)}%`, "--b": `${pct(b)}%` } as React.CSSProperties}>
        <input type="range" min={0} max={limite} step={0.5} value={a} aria-label="Início do trecho"
               onChange={(e) => setRasc([Math.min(Number(e.target.value), b), b])} />
        <input type="range" min={0} max={limite} step={0.5} value={b} aria-label="Fim do trecho"
               onChange={(e) => setRasc([a, Math.max(Number(e.target.value), a)])} />
      </div>
      <div className="campos-trecho">
        <label>Início (s)
          <input type="number" min={0} max={limite} step={0.1} value={a}
                 onChange={(e) => setRasc([Number(e.target.value), b])} />
        </label>
        <label>Fim (s)
          <input type="number" min={0} max={limite} step={0.1} value={b}
                 onChange={(e) => setRasc([a, Number(e.target.value)])} />
        </label>
      </div>
      <button type="button" className="primario largo" disabled={!mudou || curto} onClick={() => aplicar(rasc)}>
        Aplicar trecho
      </button>
      {curto && <p className="alerta aviso">Escolha um trecho de pelo menos 1 segundo.</p>}
      <p className="nota">
        {mmss(trecho[0])} → {mmss(trecho[1])} · {(trecho[1] - trecho[0]).toFixed(0)} s ·{" "}
        {((100 * (trecho[1] - trecho[0])) / Math.max(duracao, 1e-9)).toFixed(0)}% do log ({mmss(duracao)})
      </p>
      <div className="dois">
        <button type="button" className="secundario" onClick={() => aplicar([0, limite])}>Log inteiro</button>
        {trechoEmVoo && (
          <button type="button" className="secundario" title="Trecho em que a aeronave estava em movimento"
                  onClick={() => aplicar([r1(trechoEmVoo[0]), Math.min(limite, r1(trechoEmVoo[1]))])}>
            Só o voo
          </button>
        )}
      </div>
    </section>
  );
}
