/**
 * Gráfico Plotly avulso (box plot, espectro, dispersão...). Usa a mesma
 * cópia do Plotly que o painel de voo já traz, carregada só quando a
 * primeira aba com gráfico abre.
 */
import { useEffect, useRef } from "react";
import { useTemaEscuro } from "../tema";

type Plotly = {
  react: (el: HTMLElement, dados: unknown[], layout: unknown, config: unknown) => Promise<unknown>;
  purge: (el: HTMLElement) => void;
  Plots: { resize: (el: HTMLElement) => void };
};
declare global { interface Window { Plotly?: Plotly } }

let carregando: Promise<Plotly> | null = null;
function carregarPlotly(): Promise<Plotly> {
  if (window.Plotly) return Promise.resolve(window.Plotly);
  carregando ??= new Promise((ok, falha) => {
    const s = document.createElement("script");
    s.src = "/painel_voo_web/vendor/plotly.min.js";
    s.onload = () => (window.Plotly ? ok(window.Plotly) : falha(new Error("Plotly não carregou")));
    s.onerror = () => falha(new Error("Não foi possível carregar o Plotly"));
    document.head.appendChild(s);
  });
  return carregando;
}

interface Props {
  dados: unknown[];
  layout?: Record<string, unknown>;
  altura?: number;
  titulo: string;
}

export function Grafico({ dados, layout = {}, altura = 360, titulo }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const escuro = useTemaEscuro();

  useEffect(() => {
    let vivo = true;
    carregarPlotly().then((P) => {
      if (!vivo || !ref.current) return;
      const css = getComputedStyle(document.documentElement);
      const texto = css.getPropertyValue("--texto").trim();
      const grade = css.getPropertyValue("--borda").trim();
      const eixo = (extra: unknown) => ({ gridcolor: grade, zerolinecolor: grade, ...(extra as object) });
      P.react(ref.current, dados, {
        height: altura,
        margin: { l: 50, r: 10, t: 10, b: 45 },
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        font: { color: texto, family: "Inter, Segoe UI, sans-serif", size: 12 },
        legend: { orientation: "h", y: -0.2 },
        ...layout,
        xaxis: eixo(layout.xaxis),
        yaxis: eixo(layout.yaxis),
      }, { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["lasso2d", "select2d"] });
    });
    return () => { vivo = false; };
  }, [dados, layout, altura, escuro]);

  useEffect(() => () => { if (ref.current && window.Plotly) window.Plotly.purge(ref.current); }, []);

  return <div ref={ref} className="grafico" role="img" aria-label={titulo} style={{ minHeight: altura }} />;
}
