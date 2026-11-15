/** Aba Saúde do sistema (porta de visualization/abas/saude.py). */
import { useState } from "react";
import { calcularSaude } from "../cliente";
import { LIMITES_SAUDE } from "../lib/abas/saude";
import { Aba, Filtro, PainelDoTrecho, contem, useConsulta, type PropsAba } from "../componentes/comum";

const CLASSE: Record<string, string> = { Crítico: "critico", Atenção: "atencao", OK: "ok", "Sem dados": "sem" };

export function AbaSaude({ info, trecho, onTrecho }: PropsAba) {
  const { dados: r, erro, carregando } = useConsulta(() => calcularSaude({ inicio: trecho[0], fim: trecho[1] }), [info, trecho]);
  const [filtro, setFiltro] = useState("");
  return (
    <Aba erro={erro} carregando={carregando} pronto={!!r}>
      {r && <>
        <h2 className="subtitulo">Quadro de saúde do trecho</h2>
        <div className="rolagem">
          <table className="tabela">
            <thead><tr><th>Componente</th><th>Situação</th><th>Detalhe</th></tr></thead>
            <tbody>
              {r.quadro.map((q) => (
                <tr key={q.Componente}>
                  <td>{q.Componente}</td>
                  <td><span className={`selo ${CLASSE[q.Situação]}`}>{q.Situação}</span></td>
                  <td>{q.Detalhe}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details className="resumo">
          <summary>Como ler este quadro</summary>
          <ul>
            {Object.entries(LIMITES_SAUDE).map(([k, [v, txt]]) => <li key={k}><b>{k}</b>: {txt} (limite {v})</li>)}
            <li>Se a controladora estiver montada ao contrário ou sem calibração, o EKF fica instável (medidas
              rejeitadas e realinhamentos) — corrija a instalação antes de confiar nele.</li>
          </ul>
        </details>

        <PainelDoTrecho dados={r.painel} onTrecho={onTrecho} />

        {r.mensagens && (
          <details className="resumo">
            <summary>Mensagens do firmware no trecho ({r.mensagens.length})</summary>
            <Filtro valor={filtro} onMudar={setFiltro} placeholder="Filtrar texto (ex.: EKF, failsafe, PreArm)" />
            <div className="rolagem alta">
              <table className="tabela">
                <thead><tr><th>instante</th><th>mensagem</th></tr></thead>
                <tbody>
                  {r.mensagens.filter((m) => contem(m.mensagem, filtro)).map((m, i) => (
                    <tr key={i}><td className="num">{m.instante}</td><td>{m.mensagem}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </>}
    </Aba>
  );
}
