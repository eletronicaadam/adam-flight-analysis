/** Aba Replay 3D (porta de visualization/abas/replay.py): usa o painel replay_voo_web. */
import { useEffect, useState } from "react";
import { calcularReplay } from "../cliente";
import { PainelIframe } from "../componentes/PainelIframe";
import { Aba, useConsulta, type PropsAba } from "../componentes/comum";

type Fonte = "GPS" | "barômetro";

export function AbaReplay({ info, trecho, versaoFicha }: PropsAba) {
  // null = padrão do trecho (GPS se o barômetro discorda dele em voo).
  const [fonte, setFonte] = useState<Fonte | null>(null);
  useEffect(() => setFonte(null), [info, trecho]);
  const { dados: r, erro, carregando } = useConsulta(
    () => calcularReplay({ inicio: trecho[0], fim: trecho[1], fonteAltura: fonte }), [info, trecho, fonte, versaoFicha]);

  return (
    <Aba erro={erro} carregando={carregando} pronto={!!r} texto="Montando o replay 3D…">
      {r && <>
        <div className="controles" role="radiogroup" aria-label="Altura por">
          <span className="nota">Altura por:</span>
          {(["GPS", "barômetro"] as const).map((f) => (
            <label key={f} className="opcao" title="O GPS é usado por padrão quando o barômetro discorda dele em voo.">
              <input type="radio" name="replay-altura" checked={r.fonteAltura === f} onChange={() => setFonte(f)} />{f}
            </label>
          ))}
          {r.barometroRuim && (
            <span className="nota">O barômetro discordou do GPS neste trecho (provável fluxo de ar no sensor): altura pelo GPS.</span>
          )}
        </div>
        {(r.payload.pos as { t: unknown[] }).t.length === 0
          ? <div className="alerta aviso">Sem GPS com fix neste trecho: não há trajeto para o replay.</div>
          : <PainelIframe pasta="replay_voo_web" dados={r.payload} />}
        <p className="nota">Câmera: <b>Perseguição</b> segue o avião por trás; <b>Livre</b> deixa girar/aproximar com o
          mouse; <b>Visão geral</b> mostra o trajeto todo. Use “Tamanho do avião” para enxergá-lo de longe.</p>
      </>}
    </Aba>
  );
}
