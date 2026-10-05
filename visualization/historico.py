import sys
from pathlib import Path

import pandas as pd
import plotly.express as px
import streamlit as st

sys.path.append(str(Path(__file__).resolve().parent.parent))

import config


st.set_page_config(page_title="Adam Aerodesign - Histórico de Voos", layout="wide")
st.title("Histórico de Voos")

caminho_historico = config.PASTA_CSV / "historico_voos.csv"

if not caminho_historico.exists():
    st.warning(
        "Nenhum histórico de voos encontrado ainda. Rode "
        "'python exportar_csv.py' primeiro para gerar o histórico."
    )
    st.stop()

historico = pd.read_csv(caminho_historico)

historico = historico.sort_values("arquivo").reset_index(drop=True)

filtro_texto = st.text_input("Filtrar por nome do arquivo (opcional)")
if filtro_texto:
    historico = historico[historico["arquivo"].str.contains(filtro_texto, case=False, na=False)]

st.subheader(f"Todos os voos ({len(historico)})")
st.dataframe(historico.set_index("arquivo"), use_container_width=True)

if len(historico) < 2:
    st.info("Processe mais voos para ver a evolução de métricas ao longo do tempo.")
    st.stop()

st.subheader("Evolução de uma métrica ao longo dos voos")

colunas_numericas = historico.select_dtypes(include="number").columns.tolist()
metrica_escolhida = st.selectbox("Escolha a métrica", colunas_numericas)

fig = px.line(
    historico,
    x="arquivo",
    y=metrica_escolhida,
    markers=True,
    labels={"arquivo": "Voo", metrica_escolhida: metrica_escolhida},
    title=f"Evolução de {metrica_escolhida}",
)
st.plotly_chart(fig, use_container_width=True)