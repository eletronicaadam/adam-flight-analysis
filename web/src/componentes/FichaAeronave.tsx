/**
 * Ficha da aeronave na barra lateral: resumo e editor do TOML (mesmo
 * formato do aeronave.toml). A versão editada fica guardada neste
 * navegador; "Restaurar padrão" volta para a do repositório.
 */
import { useEffect, useRef, useState } from "react";
import fichaPadrao from "../../../aeronave.toml?raw";
import { definirFicha } from "../cliente";
import type { Ficha } from "../lib/ficha";

const CHAVE = "adam.ficha.toml";

function lerGuardada(): string | null {
  try { return localStorage.getItem(CHAVE); } catch { return null; }
}
function guardar(texto: string | null) {
  try { if (texto === null) localStorage.removeItem(CHAVE); else localStorage.setItem(CHAVE, texto); } catch { /* sem armazenamento */ }
}

interface Props { onFicha: (f: Ficha) => void; ficha: Ficha | null }

export function FichaAeronave({ onFicha, ficha }: Props) {
  const [texto, setTexto] = useState(() => lerGuardada() ?? fichaPadrao);
  const [rascunho, setRascunho] = useState(texto);
  const [erro, setErro] = useState<string | null>(null);
  const dialogo = useRef<HTMLDialogElement>(null);
  const personalizada = texto !== fichaPadrao;

  useEffect(() => {
    definirFicha(texto).then(onFicha).catch(async (e) => {
      // Ficha guardada com erro: volta para a padrão para não travar as análises.
      setErro(`A ficha guardada tem um erro (${e.message}); usando a padrão.`);
      guardar(null);
      setTexto(fichaPadrao);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texto]);

  const salvar = async () => {
    try {
      await definirFicha(rascunho);
      guardar(rascunho === fichaPadrao ? null : rascunho);
      setTexto(rascunho);
      setErro(null);
      dialogo.current?.close();
    } catch (e) {
      setErro(`Não salvei: ${e instanceof Error ? e.message : e}`);
    }
  };

  const fmt = (v: number | null | undefined, u: string) => (v ? `${v.toLocaleString("pt-BR")} ${u}` : "—");
  return (
    <section className="bloco">
      <h2>Ficha da aeronave</h2>
      {ficha && (
        <div className="nota">
          <b>{ficha.nome || "Sem nome"}</b>{personalizada ? " (editada neste navegador)" : ""}<br />
          {fmt(ficha.massa_decolagem_kg, "kg")} · asa {fmt(ficha.area_asa_m2, "m²")} · {fmt(ficha.envergadura_m, "m")}<br />
          Bateria {ficha.bateria.celulas ? `${ficha.bateria.celulas}S` : "—"} · placa {ficha.controladora.orientacao.replace(/_/g, " ")}
          {ficha.controladora.funcao === "registrador" ? " (só registra)" : ""}
        </div>
      )}
      {erro && !dialogo.current?.open && <p className="alerta aviso">{erro}</p>}
      <button type="button" className="secundario" onClick={() => { setRascunho(texto); setErro(null); dialogo.current?.showModal(); }}>
        Editar ficha
      </button>
      <dialog ref={dialogo} className="dialogo" aria-label="Editar ficha da aeronave">
        <h2>Ficha da aeronave</h2>
        <p className="nota">Mesmo formato do <code>aeronave.toml</code>. Massa, asa e envergadura entram na aba
          Aerodinâmica; bateria, controladora e propulsão mudam os limites e o que a análise considera confiável.
          Fica guardada só neste navegador.</p>
        <textarea className="editor-toml" value={rascunho} spellCheck={false} aria-label="Conteúdo da ficha (TOML)"
                  onChange={(e) => setRascunho(e.target.value)} />
        {erro && <p className="alerta erro">{erro}</p>}
        <div className="acoes">
          <button type="button" className="primario" onClick={salvar}>Salvar</button>
          <button type="button" className="secundario" onClick={() => setRascunho(fichaPadrao)}>Restaurar padrão</button>
          <button type="button" className="secundario" onClick={() => dialogo.current?.close()}>Cancelar</button>
        </div>
      </dialog>
    </section>
  );
}
