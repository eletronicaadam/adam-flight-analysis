"""
voo.py — aba principal: métricas do trecho, painel com mapa, gráficos de
velocidade/altitude/bateria e valores instantâneos.
"""

from pathlib import Path

import streamlit as st

from analysis import statistics
from visualization import dados_voo
from visualization.abas.comum import carregar_log, linha_de_metricas, mmss, mostrar, mostrar_painel


@st.cache_data(max_entries=32, show_spinner=False)
def preparar_trecho(caminho_str, versao, inicio, fim):
    """Métricas, dados do painel e KML de um trecho (só desse pedaço)."""
    log = carregar_log(caminho_str, versao)
    dados = log["dados"]
    janela = dados_voo.cortar_janela(dados, inicio, fim, log["origem"])
    resumo = statistics.resumir_voo(caminho_str, dados=janela)
    # As análises medem a altitude a partir do início do trecho; para não
    # contradizer o painel, usamos a mesma referência dele (solo).
    altitude_max = dados_voo.altitude_maxima(dados, janela)
    fonte_altitude = "BARO" if resumo.get("altitude", {}).get("fonte") == "BARO" else "GPS"
    for categoria, fonte in (("altitude", fonte_altitude), ("gps", "GPS")):
        if altitude_max[fonte] is not None and "altitude_maxima_m" in resumo.get(categoria, {}):
            resumo[categoria]["altitude_maxima_m"] = altitude_max[fonte]
    painel = dados_voo.montar_painel(dados, inicio, fim)
    painel["id"] = f"voo|{caminho_str}|{versao}|{inicio}|{fim}"
    painel["arquivo"] = caminho_str
    nome = f"{Path(caminho_str).stem} ({inicio:.0f}-{fim:.0f} s)"
    kml = dados_voo.gerar_kml(dados, inicio, fim, nome)
    return painel, resumo, kml


def maximo_da_serie(painel, chave):
    serie = painel["series"].get(chave)
    if not serie:
        return None
    valores = [v for v in serie["y"] if v is not None]
    return max(valores) if valores else None


def mostrar_aba(ctx):
    with st.spinner("Preparando o trecho..."):
        painel, resumo, kml = preparar_trecho(ctx.caminho_str, ctx.versao, ctx.inicio, ctx.fim)

    gps = resumo.get("gps", {})
    bat = resumo.get("bateria", {})
    linha_de_metricas([
        ("Duração do trecho", mmss(ctx.fim - ctx.inicio)),
        ("Distância", mostrar(gps.get("distancia_percorrida_m"), "{:.0f} m")),
        ("Alt. máx. (baro)", mostrar(maximo_da_serie(painel, "altitude"), "{:.1f} m")),
        ("Alt. máx. (GPS)", mostrar(maximo_da_serie(painel, "altitude_gps"), "{:.1f} m")),
        ("Vel. solo máx.", mostrar(gps.get("velocidade_maxima_ms"), "{:.1f} m/s")),
        ("Vel. ar máx.", mostrar(maximo_da_serie(painel, "vel_ar"), "{:.1f} m/s")),
        ("Consumo", mostrar(bat.get("consumo_mah"), "{:.0f} mAh")),
        ("Energia", mostrar(bat.get("consumo_wh"), "{:.1f} Wh")),
        ("Tensão mín.", mostrar(bat.get("tensao_minima_v"), "{:.2f} V")),
        ("Corrente máx.", mostrar(bat.get("corrente_maxima_a"), "{:.1f} A")),
        ("Potência máx.", mostrar(bat.get("potencia_maxima_w"), "{:.0f} W")),
    ])

    erros = [f"{categoria}: {valores['erro']}" for categoria, valores in resumo.items()
             if isinstance(valores, dict) and "erro" in valores]
    if erros:
        st.caption("Não calculado neste trecho — " + " · ".join(erros))
    for aviso in painel.get("avisos", []):
        st.warning(aviso)

    mostrar_painel(painel, ctx, key="painel_voo")

    col_kml, _ = st.columns([1, 3])
    if kml:
        col_kml.download_button(
            "Baixar trajeto (KML)",
            data=kml,
            file_name=f"{ctx.caminho.stem}_{ctx.inicio:.0f}-{ctx.fim:.0f}s.kml",
            mime="application/vnd.google-earth.kml+xml",
            help="Abra no Google Earth ou importe no Google My Maps",
        )

    with st.expander("Resumo completo do trecho"):
        for categoria, valores in resumo.items():
            if categoria == "arquivo" or not isinstance(valores, dict):
                continue
            st.markdown(f"**{categoria.capitalize()}**")
            st.dataframe(
                # Tudo como texto: a coluna mistura números e textos (ex: fonte).
                [{"métrica": k, "valor": (f"{v:.3f}" if isinstance(v, float) else str(v))}
                 for k, v in valores.items()],
                hide_index=True,
                width="stretch",
            )
