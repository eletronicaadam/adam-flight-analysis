import { useEffect, useState } from "react";

const consulta = () => window.matchMedia("(prefers-color-scheme: dark)");

/** true quando o sistema está em modo escuro (acompanha a mudança ao vivo). */
export function useTemaEscuro(): boolean {
  const [escuro, setEscuro] = useState(() => consulta().matches);
  useEffect(() => {
    const m = consulta();
    const f = () => setEscuro(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return escuro;
}
