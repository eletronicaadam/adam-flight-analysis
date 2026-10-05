"""
replay.py — aba Replay 3D: trajeto em 3D e um modelo do avião com a
atitude de cada instante, com barra de tempo e eventos detectados.
"""

import math

import numpy as np
import streamlit as st

import utils
from analysis import eventos as eventos_mod
from analysis.atitude import atitude_confiavel
from analysis.ficha import carregar_ficha, versao_ficha
from visualization import dados_voo
from visualization.abas.comum import carregar_log_completo
from visualization.replay_voo import replay_voo

MAX_PONTOS_POSICAO = 4000
MAX_PONTOS_ATITUDE = 8000


@st.cache_data(max_entries=4, show_spinner=False)
def _eventos_do_log(caminho_str, versao, ficha_versao):
    """Eventos de segurança do log inteiro (Fase A), para marcar no replay."""
    completo = carregar_log_completo(caminho_str, versao)
    resultado = eventos_mod.detectar(completo["dados"], carregar_ficha())
    return [
        {"t": e["inicio_s"], "fim": e["fim_s"] if e["fim_s"] is not None else e["inicio_s"],
         "titulo": e["titulo"], "gravidade": e["gravidade"]}
        for e in resultado["eventos"]
        if e["gravidade"] in ("critico", "atencao") and e["inicio_s"] is not None
        # mensagens de pré-voo cobrem o log todo e poluiriam a barra
        and not e["codigo"].startswith("msg_")
    ]


@st.cache_data(max_entries=8, show_spinner=False)
def _preparar(caminho_str, versao, inicio, fim, fonte_altura, ficha_versao):
    completo = carregar_log_completo(caminho_str, versao)
    dados, origem = completo["dados"], completo["origem"]
    ficha = carregar_ficha()
    janela = dados_voo.cortar_janela(dados, inicio, fim, origem, tipos=("GPS", "BARO"))
    gps = dados_voo.gps_valido(janela)
    payload = {"id": f"replay|{caminho_str}|{versao}|{inicio}|{fim}|{fonte_altura}", "inicio": inicio, "fim": fim,
               "envergadura_m": ficha.get("envergadura_m") or 2.0, "pos": {"t": []}, "att": None,
               "fonte_atitude": "", "fonte_altura": fonte_altura, "eventos": []}
    if gps is None:
        return payload

    # Posição local (m) em relação ao primeiro ponto do trecho.
    lat0, lng0 = float(gps["Lat"].iloc[0]), float(gps["Lng"].iloc[0])
    norte = (gps["Lat"].to_numpy() - lat0) * 111_320.0
    leste = (gps["Lng"].to_numpy() - lng0) * 111_320.0 * math.cos(math.radians(lat0))
    t_gps = dados_voo.segundos(gps, origem)
    refs = dados_voo.referencias_altitude(dados)
    if fonte_altura == "barômetro" and "BARO" in janela and refs["BARO"] is not None:
        baro = utils.filtrar_instancia(janela["BARO"], "I")
        altura = np.interp(t_gps, dados_voo.segundos(baro, origem), baro["Alt"].to_numpy() - refs["BARO"])
    else:
        altura = gps["Alt"].to_numpy() - (refs["GPS"] if refs["GPS"] is not None else float(gps["Alt"].iloc[0]))
    passo = max(1, math.ceil(len(gps) / MAX_PONTOS_POSICAO))
    idx = np.unique(np.r_[np.arange(0, len(gps), passo), len(gps) - 1])
    colunas = {"e": leste, "n": norte, "u": altura, "v": gps["Spd"].to_numpy()}
    if "GCrs" in gps.columns:
        colunas["rumo"] = gps["GCrs"].to_numpy()
    t_sel, sel = dados_voo._amostrar(t_gps, idx, colunas)
    payload["pos"] = {"t": dados_voo._lista(t_sel, 3), **{k: dados_voo._lista(v, 2) for k, v in sel.items()}}

    atitude, fonte = atitude_confiavel(dados, ficha, origem, inicio, fim)
    payload["fonte_atitude"] = fonte
    if atitude is not None:
        atitude = atitude[(atitude["t"] >= inicio) & (atitude["t"] <= fim)]
        passo = max(1, math.ceil(len(atitude) / MAX_PONTOS_ATITUDE))
        atitude = atitude.iloc[::passo]
        payload["att"] = {"t": dados_voo._lista(atitude["t"], 3), "roll": dados_voo._lista(atitude["Roll"], 1),
                          "pitch": dados_voo._lista(atitude["Pitch"], 1), "yaw": dados_voo._lista(atitude["Yaw"], 1)}
    payload["eventos"] = [e for e in _eventos_do_log(caminho_str, versao, ficha_versao) if inicio <= e["t"] <= fim]
    return payload


def mostrar_aba(ctx):
    ctx.completo()
    janela = dados_voo.cortar_janela(ctx.dados, ctx.inicio, ctx.fim, ctx.origem)
    divergencia = dados_voo.divergencia_altitude(janela, ctx.origem, dados_voo.referencias_altitude(ctx.dados))
    barometro_ruim = bool(divergencia and divergencia["p95_m"] > dados_voo.DIVERGENCIA_ALTITUDE_M)
    c1, c2 = st.columns([1, 3])
    fonte_altura = c1.radio("Altura por", ["GPS", "barômetro"], index=0 if barometro_ruim else 1, horizontal=True,
                            # chave muda com o trecho: o padrão (GPS se o baro diverge) vale a cada trecho novo
                            key=f"replay_altura::{ctx.caminho_str}::{ctx.inicio}::{ctx.fim}::{barometro_ruim}",
                            help="O GPS é usado por padrão quando o barômetro discorda dele em voo.")
    if barometro_ruim:
        c2.caption("O barômetro discordou do GPS neste trecho (provável fluxo de ar no sensor): altura pelo GPS.")
    with st.spinner("Montando o replay 3D..."):
        payload = _preparar(ctx.caminho_str, ctx.versao, ctx.inicio, ctx.fim, fonte_altura, versao_ficha())
    replay_voo(payload, key="replay_voo")
    st.caption("Câmera: **Perseguição** segue o avião por trás; **Livre** deixa girar/aproximar com o mouse; "
               "**Visão geral** mostra o trajeto todo. Use “Tamanho do avião” para enxergá-lo de longe.")
