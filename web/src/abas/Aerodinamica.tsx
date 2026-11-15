/** Aba Aerodinâmica (porta de visualization/abas/aerodinamica.py). */
import { useEffect, useMemo, useState } from "react";
import { calcularAero } from "../cliente";
import { G } from "../lib/analise/aerodinamica";
import { fmt } from "../formato";
import { Grafico } from "../componentes/Grafico";
import { Aba, Metricas, PainelDoTrecho, useAtrasado, useConsulta, type PropsAba } from "../componentes/comum";

interface Campo { chave: "massa" | "area" | "envergadura" | "temperatura"; rotulo: string; min: number; max: number; passo: number; ajuda?: string }
const CAMPOS: Campo[] = [
  { chave: "massa", rotulo: "Massa (kg)", min: 0.1, max: 50, passo: 0.1, ajuda: "Da ficha da aeronave; altere para simular outra carga." },
  { chave: "area", rotulo: "Área da asa (m²)", min: 0.05, max: 10, passo: 0.01 },
  { chave: "envergadura", rotulo: "Envergadura (m)", min: 0.2, max: 10, passo: 0.05 },
  { chave: "temperatura", rotulo: "Temperatura do ar (°C)", min: -10, max: 50, passo: 1,
    ajuda: "Temperatura do dia do voo (a do barômetro é a da placa, mais quente)." },
];

export function AbaAerodinamica({ info, trecho, onTrecho, ficha, versaoFicha }: PropsAba) {
  const daFicha = () => ({
    massa: ficha.massa_decolagem_kg ?? 5.0, area: ficha.area_asa_m2 ?? 1.0, envergadura: ficha.envergadura_m ?? 2.0, temperatura: 25,
  });
  const [valores, setValores] = useState(daFicha);
  useEffect(() => setValores((v) => ({ ...daFicha(), temperatura: v.temperatura })), [versaoFicha]); // eslint-disable-line
  // null = padrão do trecho (só corrige pelo vento quando a estimativa é confiável).
  const [usarVento, setUsarVento] = useState<boolean | null>(null);
  useEffect(() => setUsarVento(null), [info, trecho]);

  const p = useAtrasado(valores);
  const validos = CAMPOS.every((c) => Number.isFinite(p[c.chave]) && p[c.chave] >= c.min && p[c.chave] <= c.max);
  const { dados: r, erro, carregando } = useConsulta(
    () => (validos ? calcularAero({ inicio: trecho[0], fim: trecho[1], parametros: { ...p, usarVento } }) : Promise.resolve(undefined)),
    [info, trecho, p, usarVento, versaoFicha]);

  const d = r?.dispersao;
  const sustentacao = useMemo(() => {
    if (!d) return null;
    const i = d.cl.flatMap((v, k) => (Number.isFinite(v) && Number.isFinite(d.alfa[k]) ? [k] : []));
    return i.length ? [{ type: "scatter", mode: "markers", x: i.map((k) => d.alfa[k]), y: i.map((k) => d.cl[k]),
      marker: { size: 5, color: i.map((k) => d.t[k]), colorscale: "Viridis", showscale: true, colorbar: { title: { text: "t (s)" } } },
      hovertemplate: "α %{x:.1f}°<br>CL %{y:.2f}<extra></extra>" }] : null;
  }, [d]);
  const potencia = useMemo(() => {
    if (!d) return null;
    const i = d.potencia.flatMap((v, k) => (Number.isFinite(v) && Number.isFinite(d.vel_ar[k]) ? [k] : []));
    return i.length ? [{ type: "scatter", mode: "markers", x: i.map((k) => d.vel_ar[k]), y: i.map((k) => d.potencia[k]),
      marker: { size: 5, color: i.map((k) => d.n[k]), colorscale: "Plasma", showscale: true, colorbar: { title: { text: "n (g)" } } },
      hovertemplate: "%{x:.1f} m/s<br>%{y:.0f} W<extra></extra>" }] : null;
  }, [d]);
  const layoutCl = useMemo(() => ({ xaxis: { title: { text: "α estimado (°)" } }, yaxis: { title: { text: "CL" } } }), []);
  const layoutPot = useMemo(() => ({
    xaxis: { title: { text: "velocidade do ar estimada (m/s)" } }, yaxis: { title: { text: "potência elétrica (W)" } },
  }), []);

  const controles = (
    <div className="controles campos-aero">
      {CAMPOS.map((c) => (
        <label key={c.chave} title={c.ajuda}>{c.rotulo}
          <input className="campo" type="number" min={c.min} max={c.max} step={c.passo} value={valores[c.chave]}
                 onChange={(e) => setValores({ ...valores, [c.chave]: e.target.valueAsNumber })} />
        </label>
      ))}
      <label className="opcao" title="Recomendado só quando o trecho tem curvas completas (circuito).">
        <input type="checkbox" checked={r?.usouVento ?? false} disabled={!r}
               onChange={(e) => setUsarVento(e.target.checked)} />
        Corrigir pelo vento estimado
      </label>
    </div>
  );

  const res = r?.resumo;
  const vento = r?.vento;
  return (
    <div className="aba">
      <p className="nota">Estimativas sem tubo de Pitot: dependem do vento ser constante e de haver curvas no trecho.
        Use como ordem de grandeza e para comparar voos.</p>
      {controles}
      {!validos && <div className="alerta aviso">Confira os valores: algum campo está vazio ou fora do intervalo.</div>}
      {validos && r === null && !carregando && <div className="alerta aviso">Sem GPS com o avião em movimento neste trecho.</div>}
      <Aba erro={erro} carregando={carregando} pronto={!!r || !validos}>
        {r && res && <>
          <Metricas itens={[
            ["Densidade do ar", fmt(r.rho, 3, "kg/m³"), `Pressão ${fmt(r.pressao / 100, 0)} hPa e ${fmt(p.temperatura, 0)} °C`],
            ["Carga alar", fmt(r.carga_alar, 2, "kg/m²"), `${fmt(r.carga_alar * G, 1)} N/m²`],
            ["Vento estimado", vento ? `${fmt(vento.velocidade_ms, 1)} m/s de ${fmt(vento.direcao_de_graus, 0)}°` : null,
              vento ? `Cobertura de rumos ${vento.cobertura_rumos_graus}°; resíduo ${fmt(vento.residuo_ms, 2)} m/s` : undefined],
            ["Vel. do ar (mediana)", fmt(res.va_mediana, 1, "m/s")],
            ["Vel. do ar mínima", fmt(res.va_min, 1, "m/s"), "percentil 2, em voo"],
            ["CL em voo (mediana)", fmt(res.cl_mediano, 2)],
            ["CL em voo (p95)", fmt(res.cl_p95, 2)],
            ["Fator de carga máx.", fmt(res.n_max, 2, "g")],
            ["α estimado (mediana)", res.alfa_mediano === null ? null : `${fmt(res.alfa_mediano, 1)}°`, `Atitude ${r.fonte_atitude}`],
            ["Reynolds (corda média)", res.re_mediano === null ? null : `${fmt(res.re_mediano / 1e3, 0)} mil`,
              `Corda média = área/envergadura = ${fmt(res.corda, 3)} m`],
          ]} />
          {vento && !vento.confiavel && (
            <div className="alerta aviso">
              Estimativa de vento pouco confiável neste trecho ({vento.cobertura_rumos_graus}° de variação de rumo, resíduo{" "}
              {fmt(vento.residuo_ms, 1)} m/s): o método supõe velocidade do ar constante e precisa de quase uma volta
              completa. {r.usouVento ? "Atenção: a correção está ligada mesmo assim."
                : "Correção pelo vento desligada — velocidades e CL usam a velocidade no solo."}
            </div>
          )}

          <PainelDoTrecho dados={r.painel} onTrecho={onTrecho} />

          <div className="grade2">
            <section>
              <h2 className="subtitulo">Curva de sustentação estimada (CL × α)</h2>
              {sustentacao ? <>
                <Grafico titulo="CL em função do ângulo de ataque estimado" dados={sustentacao} layout={layoutCl} />
                <p className="nota">Com mais voos (e um Pitot), esses pontos formam a curva CL×α real do avião e mostram o CLmax.</p>
              </> : <div className="alerta aviso">Sem atitude/velocidade suficientes para α.</div>}
            </section>
            <section>
              <h2 className="subtitulo">Potência × velocidade do ar</h2>
              {potencia ? <>
                <Grafico titulo="Potência elétrica em função da velocidade do ar" dados={potencia} layout={layoutPot} />
                <p className="nota">Em voo nivelado e sem acelerar, estes pontos formam a curva de potência necessária.</p>
              </> : <div className="alerta aviso">Sem medição de corrente/tensão para a potência.</div>}
            </section>
          </div>

          <h2 className="subtitulo">Velocidade de estol estimada</h2>
          <div className="rolagem">
            <table className="tabela">
              <thead><tr><th>CLmax do perfil</th><th>Estol em voo nivelado</th><th>Em curva de 30°</th><th>Em curva de 45°</th></tr></thead>
              <tbody>
                {r.estol.map((e) => (
                  <tr key={e.cl_max}>
                    <td className="num">{fmt(e.cl_max, 1)}</td><td className="num">{fmt(e.nivelado, 1, "m/s")}</td>
                    <td className="num">{fmt(e.curva30, 1, "m/s")}</td><td className="num">{fmt(e.curva45, 1, "m/s")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {res.va_min !== null && (
            <p className="nota">Velocidade do ar mínima estimada neste trecho: {fmt(res.va_min, 1)} m/s. Compare com a linha
              do CLmax do perfil de vocês: se estiver perto, o avião voou perto do estol.</p>
          )}
        </>}
      </Aba>
    </div>
  );
}
