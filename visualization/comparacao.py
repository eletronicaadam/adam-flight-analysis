import sys
from pathlib import Path

import pandas as pd
import plotly.express as px
import streamlit as st

sys.path.append(str(Path(__file__).resolve().parent.parent))

import config


st.set_page_config(page_title="Adam Aerodesign - Comparação de Voos", layout="wide")
st.title("Comparação entre Voos")

caminho_historico = config.PASTA_CSV / "historico_voos.csv"

if not caminho_historico.exists():
    st.warning(
        "Nenhum histórico de voos encontrado ainda. Rode "
        "'python exportar_csv.py' primeiro para gerar o histórico."
    )
    st.stop()

historico = pd.read_csv(caminho_historico)

voos_disponiveis = historico["arquivo"].tolist()
voos_escolhidos = st.multiselect(
    "Escolha 2 ou mais voos para comparar",
    voos_disponiveis,
    default=voos_disponiveis[: min(2, len(voos_disponiveis))],
)

if len(voos_escolhidos) < 2:
    st.info("Escolha pelo menos 2 voos para comparar.")
    st.stop()

subconjunto = historico[historico["arquivo"].isin(voos_escolhidos)]

st.subheader("Tabela comparativa")
st.dataframe(subconjunto.set_index("arquivo"), use_container_width=True)

st.subheader("Comparação de uma métrica específica")

colunas_numericas = subconjunto.select_dtypes(include="number").columns.tolist()
metrica_escolhida = st.selectbox("Escolha a métrica", colunas_numericas)

fig = px.bar(
    subconjunto,
    x="arquivo",
    y=metrica_escolhida,
    labels={"arquivo": "Voo", metrica_escolhida: metrica_escolhida},
    title=f"{metrica_escolhida} por voo",
)
st.plotly_chart(fig, use_container_width=True)