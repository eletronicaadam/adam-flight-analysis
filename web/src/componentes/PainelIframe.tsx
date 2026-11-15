/**
 * Hospeda um dos painéis HTML/JS do projeto (painel_voo_web, replay_voo_web)
 * num iframe, falando o mesmo protocolo de componentes do Streamlit que
 * eles já usam. Assim o código dos painéis é o mesmo nos dois sistemas.
 */
import { useEffect, useRef, useState } from "react";
import { useTemaEscuro } from "../tema";

interface Props {
  pasta: "painel_voo_web" | "replay_voo_web";
  dados: unknown;
  onValor?: (valor: unknown) => void;
}

function temaStreamlit(escuro: boolean) {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return {
    base: escuro ? "dark" : "light",
    backgroundColor: v("--fundo"),
    secondaryBackgroundColor: v("--fundo2"),
    textColor: v("--texto"),
    primaryColor: v("--destaque"),
    font: "Inter, Segoe UI",
  };
}

export function PainelIframe({ pasta, dados, onValor }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [pronto, setPronto] = useState(false);
  const [altura, setAltura] = useState(600);
  const escuro = useTemaEscuro();
  const onValorRef = useRef(onValor);
  onValorRef.current = onValor;

  useEffect(() => {
    const aoReceber = (ev: MessageEvent) => {
      if (ev.source !== ref.current?.contentWindow) return;
      const msg = ev.data;
      if (!msg || !msg.isStreamlitMessage) return;
      if (msg.type === "streamlit:componentReady") setPronto(true);
      else if (msg.type === "streamlit:setFrameHeight") setAltura(msg.height);
      else if (msg.type === "streamlit:setComponentValue") onValorRef.current?.(msg.value);
    };
    window.addEventListener("message", aoReceber);
    return () => window.removeEventListener("message", aoReceber);
  }, []);

  useEffect(() => {
    if (!pronto || !ref.current?.contentWindow) return;
    ref.current.contentWindow.postMessage(
      { type: "streamlit:render", args: { dados }, theme: temaStreamlit(escuro) },
      window.location.origin,
    );
  }, [pronto, dados, escuro]);

  return (
    <iframe
      ref={ref}
      className="painel-iframe"
      src={`/${pasta}/index.html`}
      title={pasta === "painel_voo_web" ? "Painel de voo" : "Replay 3D"}
      style={{ height: altura }}
    />
  );
}
