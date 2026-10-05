"""
aerodinamica.py — aba Aerodinâmica: vento estimado, velocidade do ar
estimada, coeficiente de sustentação em voo, fator de carga, ângulo de
ataque estimado, Reynolds e velocidades de estol, usando a ficha da
aeronave (massa, área e envergadura).
"""

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

import utils
from analysis import aerodinamica as aero
from analysis.atitude import atitude_confiavel
from analysis.ficha import carregar_ficha, versao_ficha
from visualization import dados_voo
from visualization.abas.comum import carregar_log_completo, linha_de_metricas, mostrar_painel

CL_MAX_REFERENCIA = (1.2, 1.4, 1.6, 1.8, 2.0)


def _vento(dados, origem, gps):
    """Vento estimado com o avião em velocidade quase constante (hipótese do método)."""
    t = dados_voo.segundos(gps, origem)
    vel = gps["Spd"].to_numpy(dtype=float)
    acel = np.gradient(vel, t) if len(t) > 2 else np.zeros(len(t))
    estavel = (vel > 5) & (np.abs(acel) < 1.0)
    if estavel.sum() < 10:
        return None
    return aero.estimar_vento(vel[estavel], gps["GCrs"].to_numpy(dtype=float)[estavel])


@st.cache_data(max_entries=16, show_spinner=False)
def _vento_do_trecho(caminho_str, versao, inicio, fim):
    completo = carregar_log_completo(caminho_str, versao)
    gps = aero.gps_em_movimento(completo["dados"], completo["origem"], inicio, fim)
    return None if gps is None else _vento(completo["dados"], completo["origem"], gps)


@st.cache_data(max_entries=16, show_spinner=False)
def _preparar(caminho_str, versao, inicio, fim, massa, area, envergadura, temperatura_c, usar_vento, ficha_versao):
    completo = carregar_log_completo(caminho_str, versao)
    dados, origem = completo["dados"], completo["origem"]
    gps = aero.gps_em_movimento(dados, origem, inicio, fim)
    if gps is None:
        return None

    # Densidade: pressão média do barômetro no trecho + temperatura do ar
    # informada (a temperatura do barômetro é a da placa, mais quente).
    baro = dados.get("BARO")
    pressao = 101325.0
    if baro is not None and len(baro) and "Press" in baro.columns:
        baro = utils.filtrar_instancia(baro, "I")
        tb = dados_voo.segundos(baro, origem)
        dentro = (tb >= inicio) & (tb <= fim)
        pressao = float(baro["Press"][dentro].median()) if dentro.any() else float(baro["Press"].median())
    rho = aero.densidade_ar(pressao, temperatura_c)

    vento = _vento(dados, origem, gps)

    atitude, fonte_atitude = atitude_confiavel(dados, carregar_ficha(), origem, inicio, fim)
    bat = dados.get("BAT")
    bat = utils.filtrar_instancia(bat, "Inst") if bat is not None else None
    r = aero.analisar(gps, origem, massa, area, envergadura, rho, vento if usar_vento else None, atitude, bat)

    v = r["voando"]
    linhas = [
        {"titulo": "Velocidade (m/s)", "series": [
            {"t": r["t"], "y": r["vel_solo"], "nome": "Velocidade solo (GPS)", "unidade": "m/s", "casas": 1, "cor": "#1f77b4"},
            {"t": r["t"], "y": r["vel_ar"], "nome": "Velocidade do ar (estimada)", "unidade": "m/s", "casas": 1,
             "cor": "#17becf"}]},
        {"titulo": "Coef. de sustentação CL", "series": [
            {"t": r["t"], "y": r["cl"], "nome": "CL em voo", "casas": 2, "cor": "#2ca02c"}]},
        {"titulo": "Ângulo de ataque estim. (°)", "series": [
            {"t": r["t"], "y": r["alfa"], "nome": "α estimado", "unidade": "°", "casas": 1, "cor": "#d62728"},
            {"t": r["t"], "y": r["gama"], "nome": "Trajetória γ", "unidade": "°", "casas": 1, "cor": "#9467bd"}]},
        {"titulo": "Fator de carga n (g)", "series": [
            {"t": r["t"], "y": r["fator_carga"], "nome": "Fator de carga", "unidade": "g", "casas": 2, "cor": "#8c564b"}]},
        {"titulo": "Potência elétrica (W)", "series": [
            {"t": r["t"], "y": r["potencia"], "nome": "Potência", "unidade": "W", "casas": 0, "cor": "#ff7f0e"}]},
    ]
    painel = dados_voo.montar_painel_personalizado(dados, inicio, fim, linhas, mostrar_mapa=True)
    painel["id"] = f"aero|{caminho_str}|{versao}|{inicio}|{fim}|{massa}|{area}|{envergadura}|{temperatura_c}|{usar_vento}"
    painel["arquivo"] = caminho_str

    def mediana(x):
        x = x[v & np.isfinite(x)]
        return float(np.median(x)) if len(x) else None

    va_validas = r["vel_ar"][v & np.isfinite(r["vel_ar"])]
    return {
        "rho": rho, "pressao": pressao, "vento": vento, "fonte_atitude": fonte_atitude,
        "painel": painel,
        "dispersao": pd.DataFrame({"cl": r["cl"], "alfa": r["alfa"], "vel_ar": r["vel_ar"],
                                   "potencia": r["potencia"], "n": r["fator_carga"], "t": r["t"]})[v],
        "resumo": {
            "cl_mediano": mediana(r["cl"]), "cl_p95": float(np.nanpercentile(r["cl"][v], 95)) if v.any() else None,
            "alfa_mediano": mediana(r["alfa"]), "n_max": float(np.nanmax(r["fator_carga"][v])) if v.any() else None,
            "re_mediano": mediana(r["reynolds"]), "va_min": float(np.percentile(va_validas, 2)) if len(va_validas) else None,
            "va_mediana": float(np.median(va_validas)) if len(va_validas) else None,
            "corda": r["corda_m"],
        },
    }


def mostrar_aba(ctx):
    ficha = carregar_ficha()
    st.caption("Estimativas sem tubo de Pitot: dependem do vento ser constante e de haver curvas no trecho. "
               "Use como ordem de grandeza e para comparar voos.")
    c1, c2, c3, c4, c5 = st.columns(5)
    massa = c1.number_input("Massa (kg)", 0.1, 50.0, float(ficha.get("massa_decolagem_kg") or 5.0), 0.1,
                            key="aero_massa", help="Da ficha (aeronave.toml); altere para simular outra carga.")
    area = c2.number_input("Área da asa (m²)", 0.05, 10.0, float(ficha.get("area_asa_m2") or 1.0), 0.01, key="aero_area")
    envergadura = c3.number_input("Envergadura (m)", 0.2, 10.0, float(ficha.get("envergadura_m") or 2.0), 0.05,
                                  key="aero_envergadura")
    temperatura = c4.number_input("Temperatura do ar (°C)", -10.0, 50.0, 25.0, 1.0, key="aero_temp",
                                  help="Temperatura do dia do voo (a do barômetro é a da placa, mais quente).")
    ctx.completo()
    vento_previo = _vento_do_trecho(ctx.caminho_str, ctx.versao, ctx.inicio, ctx.fim)
    confiavel = bool(vento_previo and vento_previo["confiavel"])
    # O padrão só corrige pelo vento quando a estimativa é confiável; a
    # chave muda com o trecho para o padrão valer a cada trecho novo.
    usar_vento = c5.toggle("Corrigir pelo vento estimado", confiavel,
                           key=f"aero_vento::{ctx.caminho_str}::{ctx.inicio}::{ctx.fim}",
                           help="Recomendado só quando o trecho tem curvas completas (circuito).")

    r = _preparar(ctx.caminho_str, ctx.versao, ctx.inicio, ctx.fim, massa, area, envergadura, temperatura, usar_vento,
                  versao_ficha())
    if r is None:
        st.info("Sem GPS com o avião em movimento neste trecho.")
        return

    res, vento = r["resumo"], r["vento"]
    carga_alar = massa / area
    linha_de_metricas([
        ("Densidade do ar", f"{r['rho']:.3f} kg/m³", f"Pressão {r['pressao'] / 100:.0f} hPa e {temperatura:.0f} °C"),
        ("Carga alar", f"{carga_alar:.2f} kg/m²", f"{carga_alar * aero.G:.1f} N/m²"),
        ("Vento estimado", None if not vento else f"{vento['velocidade_ms']:.1f} m/s de {vento['direcao_de_graus']:.0f}°",
         None if not vento else f"Cobertura de rumos {vento['cobertura_rumos_graus']}°; resíduo {vento['residuo_ms']:.2f} m/s"),
        ("Vel. do ar (mediana)", None if res["va_mediana"] is None else f"{res['va_mediana']:.1f} m/s"),
        ("Vel. do ar mínima", None if res["va_min"] is None else f"{res['va_min']:.1f} m/s", "percentil 2, em voo"),
        ("CL em voo (mediana)", None if res["cl_mediano"] is None else f"{res['cl_mediano']:.2f}"),
        ("CL em voo (p95)", None if res["cl_p95"] is None else f"{res['cl_p95']:.2f}"),
        ("Fator de carga máx.", None if res["n_max"] is None else f"{res['n_max']:.2f} g"),
        ("α estimado (mediana)", None if res["alfa_mediano"] is None else f"{res['alfa_mediano']:.1f}°",
         f"Atitude {r['fonte_atitude']}"),
        ("Reynolds (corda média)", None if res["re_mediano"] is None else f"{res['re_mediano'] / 1e3:.0f} mil",
         f"Corda média = área/envergadura = {res['corda']:.3f} m"),
    ])
    if vento and not vento["confiavel"]:
        st.warning(f"Estimativa de vento pouco confiável neste trecho ({vento['cobertura_rumos_graus']}° de variação "
                   f"de rumo, resíduo {vento['residuo_ms']:.1f} m/s): o método supõe velocidade do ar constante e "
                   "precisa de quase uma volta completa. " +
                   ("Correção pelo vento desligada — velocidades e CL usam a velocidade no solo."
                    if not usar_vento else "Atenção: a correção está ligada mesmo assim."))

    mostrar_painel(r["painel"], ctx, key="painel_aero")

    d = r["dispersao"]
    c1, c2 = st.columns(2)
    with c1:
        st.subheader("Curva de sustentação estimada (CL × α)")
        ok = d.dropna(subset=["cl", "alfa"])
        if len(ok):
            fig = go.Figure(go.Scatter(x=ok["alfa"], y=ok["cl"], mode="markers",
                                       marker=dict(size=5, color=ok["t"], colorscale="Viridis", showscale=True,
                                                   colorbar=dict(title="t (s)"))))
            fig.update_layout(height=360, margin=dict(l=10, r=10, t=10, b=10),
                              xaxis_title="α estimado (°)", yaxis_title="CL")
            st.plotly_chart(fig, width="stretch")
            st.caption("Com mais voos (e um Pitot), esses pontos formam a curva CL×α real do avião e mostram o CLmax.")
        else:
            st.info("Sem atitude/velocidade suficientes para α.")
    with c2:
        st.subheader("Potência × velocidade do ar")
        ok = d.dropna(subset=["potencia", "vel_ar"])
        if len(ok):
            fig = go.Figure(go.Scatter(x=ok["vel_ar"], y=ok["potencia"], mode="markers",
                                       marker=dict(size=5, color=ok["n"], colorscale="Plasma", showscale=True,
                                                   colorbar=dict(title="n (g)"))))
            fig.update_layout(height=360, margin=dict(l=10, r=10, t=10, b=10),
                              xaxis_title="velocidade do ar estimada (m/s)", yaxis_title="potência elétrica (W)")
            st.plotly_chart(fig, width="stretch")
            st.caption("Em voo nivelado e sem acelerar, estes pontos formam a curva de potência necessária.")
        else:
            st.info("Sem medição de corrente/tensão para a potência.")

    st.subheader("Velocidade de estol estimada")
    linhas = []
    for cl_max in CL_MAX_REFERENCIA:
        vs = aero.velocidade_estol(massa, area, r["rho"], cl_max)
        linhas.append({"CLmax do perfil": cl_max, "Estol em voo nivelado (m/s)": round(vs, 1),
                       "Estol em curva de 30° (m/s)": round(vs * np.sqrt(1 / np.cos(np.radians(30))), 1),
                       "Estol em curva de 45° (m/s)": round(vs * np.sqrt(1 / np.cos(np.radians(45))), 1)})
    st.dataframe(pd.DataFrame(linhas), hide_index=True, width="stretch")
    if res["va_min"] is not None:
        st.caption(f"Velocidade do ar mínima estimada neste trecho: {res['va_min']:.1f} m/s. Compare com a linha "
                   "do CLmax do perfil de vocês: se estiver perto, o avião voou perto do estol.")
