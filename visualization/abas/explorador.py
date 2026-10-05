"""
explorador.py — aba Explorador: qualquer campo de qualquer mensagem do log
em gráficos sincronizados (com mapa, barra de tempo e valores no cursor),
mais tabelas de dados, parâmetros e mensagens de texto.
"""

import numpy as np
import pandas as pd
import streamlit as st

from visualization import dados_voo
from visualization.abas.comum import carregar_log_completo, mmss, mostrar_painel

MAX_CAMPOS = 12
PADRAO = ["GPS.Spd", "GPS.Alt", "BAT.Curr", "VIBE.VibeZ"]


@st.cache_resource(max_entries=2, show_spinner=False)
def _opcoes(caminho_str, versao):
    """Todos os campos numéricos com tempo: ["GPS.Spd", ...] e contagens."""
    completo = carregar_log_completo(caminho_str, versao)
    opcoes, linhas = [], {}
    for tipo, df in sorted(completo["dados"].items()):
        if "TimeUS" not in df.columns or not len(df):
            continue
        linhas[tipo] = len(df)
        instancia = dados_voo.coluna_de_instancia(df)
        for campo in df.columns:
            if campo in ("TimeUS", instancia) or not pd.api.types.is_numeric_dtype(df[campo]):
                continue
            opcoes.append(f"{tipo}.{campo}")
    return opcoes, linhas


def _rotulo(opcao, unidades):
    tipo, campo = opcao.split(".", 1)
    unidade = unidades.get(tipo, {}).get(campo, ("", 1.0))[0]
    return f"{opcao} ({unidade})" if unidade else opcao


@st.cache_data(max_entries=16, show_spinner=False)
def _painel(caminho_str, versao, inicio, fim, campos, agrupamento, instancia, mapa):
    completo = carregar_log_completo(caminho_str, versao)
    unidades = completo["unidades"]
    specs = []
    for opcao in campos:
        tipo, campo = opcao.split(".", 1)
        unidade, fator = unidades.get(tipo, {}).get(campo, ("", 1.0))
        specs.append((tipo, {"tipo": tipo, "campo": campo, "nome": opcao, "unidade": unidade,
                             "fator": fator, "instancia": instancia}))
    if agrupamento == "Um gráfico por campo":
        linhas = [{"titulo": _rotulo(s["nome"], unidades), "series": [s]} for _, s in specs]
    elif agrupamento == "Um gráfico por mensagem":
        grupos = {}
        for tipo, s in specs:
            grupos.setdefault(tipo, []).append(s)
        linhas = [{"titulo": tipo, "series": series} for tipo, series in grupos.items()]
    else:
        linhas = [{"titulo": "Campos selecionados", "series": [s for _, s in specs]}]
    painel = dados_voo.montar_painel_personalizado(completo["dados"], inicio, fim, linhas, mostrar_mapa=mapa)
    painel["id"] = f"explorador|{caminho_str}|{versao}|{inicio}|{fim}|{campos}|{agrupamento}|{instancia}|{mapa}"
    painel["arquivo"] = caminho_str
    return painel


def _tabela(dados, origem, tipo, inicio, fim, instancia):
    df = dados[tipo]
    t = dados_voo.segundos(df, origem)
    dentro = (t >= inicio) & (t <= fim)
    coluna = dados_voo.coluna_de_instancia(df)
    if coluna is not None and instancia is not None:
        dentro &= df[coluna].to_numpy() == instancia
    return df[dentro].assign(t_s=np.round(t[dentro], 3)).drop(columns=["TimeUS"])


def mostrar_aba(ctx):
    opcoes, linhas = _opcoes(ctx.caminho_str, ctx.versao)
    completo = ctx.completo()
    unidades = completo["unidades"]

    padrao = [o for o in PADRAO if o in opcoes]
    escolhidos = st.multiselect(
        f"Campos para comparar (até {MAX_CAMPOS}; digite para buscar — ex.: BAT, Curr, VibeZ)",
        opcoes, default=padrao, max_selections=MAX_CAMPOS, key="explorador_campos",
        format_func=lambda o: _rotulo(o, unidades),
    )
    c1, c2, c3 = st.columns([3, 1, 1])
    agrupamento = c1.radio("Gráficos", ["Um gráfico por campo", "Um gráfico por mensagem", "Todos juntos"],
                           horizontal=True, key="explorador_agrupamento")
    instancia = c2.number_input("Instância do sensor", 0, 7, 0, key="explorador_instancia",
                                help="Para mensagens com mais de um sensor (GPS 2, IMU 2, núcleo do EKF...)")
    mapa = c3.toggle("Mostrar mapa", True, key="explorador_mapa")

    if not escolhidos:
        st.info("Escolha pelo menos um campo.")
    else:
        painel = _painel(ctx.caminho_str, ctx.versao, ctx.inicio, ctx.fim, tuple(escolhidos),
                         agrupamento, int(instancia), mapa)
        if not painel["series"]:
            st.warning("Nenhum dos campos tem dados neste trecho/instância.")
        mostrar_painel(painel, ctx, key="painel_explorador")

    dados, origem = completo["dados"], completo["origem"]
    with st.expander("Tabela de dados do trecho (e download em CSV)"):
        tipos = sorted({o.split(".")[0] for o in escolhidos}) or sorted(linhas)
        tipo = st.selectbox("Mensagem", tipos, key="explorador_tabela_tipo",
                            format_func=lambda t: f"{t} ({linhas.get(t, 0)} linhas no log)")
        tabela = _tabela(dados, origem, tipo, ctx.inicio, ctx.fim, int(instancia))
        st.caption(f"{len(tabela)} linhas no trecho" + (" — mostrando as primeiras 5000" if len(tabela) > 5000 else ""))
        st.dataframe(tabela.head(5000), hide_index=True, width="stretch")
        # O CSV só é gerado no clique (callable): gerar a cada rerun travaria a aba em logs grandes.
        st.download_button("Baixar CSV do trecho", lambda: tabela.to_csv(index=False).encode("utf-8"),
                           file_name=f"{ctx.caminho.stem}_{tipo}_{ctx.inicio:.0f}-{ctx.fim:.0f}s.csv",
                           mime="text/csv", on_click="ignore")

    with st.expander("Parâmetros da controladora (PARM)"):
        if "PARM" in dados:
            parametros = dados["PARM"].drop_duplicates("Name", keep="last")[["Name", "Value"]]
            busca = st.text_input("Buscar parâmetro", key="explorador_busca_parm", placeholder="ex.: BATT, AHRS, ARSPD")
            if busca:
                parametros = parametros[parametros["Name"].str.contains(busca, case=False, na=False)]
            st.dataframe(parametros.rename(columns={"Name": "parâmetro", "Value": "valor"}),
                         hide_index=True, width="stretch", height=320)
        else:
            st.caption("Este log não tem parâmetros (PARM).")

    with st.expander("Mensagens de texto do log (MSG)"):
        if "MSG" in dados:
            msg = dados["MSG"].assign(t=dados_voo.segundos(dados["MSG"], origem))
            msg = msg[(msg["t"] >= ctx.inicio) & (msg["t"] <= ctx.fim)]
            filtro = st.text_input("Filtrar texto", key="explorador_busca_msg", placeholder="ex.: EKF, failsafe")
            if filtro:
                msg = msg[msg["Message"].str.contains(filtro, case=False, na=False)]
            st.dataframe(pd.DataFrame({"instante": [mmss(x) for x in msg["t"]], "mensagem": msg["Message"]}),
                         hide_index=True, width="stretch", height=320)
        else:
            st.caption("Este log não tem mensagens de texto.")
