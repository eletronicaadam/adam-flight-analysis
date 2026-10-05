"""
dashboard.py

Dashboard de análise de um voo. Rode a partir da raiz do projeto:

    streamlit run visualization/dashboard.py

Arquitetura (pensada para ficar fluida):
- A barra lateral escolhe o arquivo e o trecho de tempo; o trecho vale
  para todas as abas. Cada mudança de trecho processa só aquele pedaço do
  log, e o resultado fica em cache.
- Só a aba aberta é calculada (as outras não rodam nada).
- Os painéis interativos (mapa, gráficos, valores instantâneos,
  reprodução, replay 3D) rodam inteiros no navegador: mover o mouse ou
  tocar a reprodução não executa nada em Python.

Cada aba fica em um arquivo de visualization/abas/.
"""

import sys
from pathlib import Path

import streamlit as st

sys.path.append(str(Path(__file__).resolve().parent.parent))

import config
from visualization.abas import aerodinamica, explorador, replay, saude, vibracao, voo
from visualization.abas.comum import Contexto, carregar_log, mmss

st.set_page_config(page_title="Adam Aerodesign - Análise de Voo", layout="wide")

# Nome da aba -> função que a desenha.
ABAS = {
    "Voo": voo.mostrar_aba,
    "Explorador": explorador.mostrar_aba,
    "Aerodinâmica": aerodinamica.mostrar_aba,
    "Replay 3D": replay.mostrar_aba,
    "Saúde do sistema": saude.mostrar_aba,
    "Vibração": vibracao.mostrar_aba,
}

# Tamanho mínimo de um trecho, em segundos.
TRECHO_MINIMO_S = 1.0


def definir_trecho(chave, inicio, fim):
    st.session_state[chave] = (float(inicio), float(fim))


def trecho_valido(inicio, fim, limite):
    """Ordena, limita a [0, limite] e garante a duração mínima."""
    inicio, fim = sorted((float(inicio), float(fim)))
    inicio, fim = max(0.0, inicio), min(limite, fim)
    if fim - inicio < TRECHO_MINIMO_S:
        meio = (inicio + fim) / 2
        inicio = max(0.0, min(meio - TRECHO_MINIMO_S / 2, limite - TRECHO_MINIMO_S))
        fim = min(limite, inicio + TRECHO_MINIMO_S)
    return round(inicio, 1), round(fim, 1)


def tamanho_mb(p):
    try:
        return p.stat().st_size / 1e6
    except OSError:
        return 0.0


def listar_logs():
    # O ArduPilot grava ".BIN" em maiúsculas; aceitamos os dois.
    arquivos = []
    for p in config.PASTA_LOGS.iterdir():
        if p.suffix.lower() == ".bin":
            try:
                arquivos.append((p.stat().st_mtime, p))
            except OSError:  # apagado/movido enquanto listávamos
                pass
    return [p for _, p in sorted(arquivos, key=lambda x: x[0], reverse=True)]


# -----------------------------------------------------------------------
# Escolha do arquivo
# -----------------------------------------------------------------------
st.sidebar.title("Análise de voo")

arquivos_bin = listar_logs()
if not arquivos_bin:
    st.error(f"Nenhum arquivo .bin encontrado em: {config.PASTA_LOGS}")
    st.stop()

# Opções pelo nome do arquivo (estável) e chave fixa: chegar um log novo
# na pasta, ou um arquivo mudar de tamanho, não troca a seleção do usuário.
por_nome = {p.name: p for p in arquivos_bin}
if st.session_state.get("arquivo_log") not in por_nome:
    st.session_state.pop("arquivo_log", None)
nome_escolhido = st.sidebar.selectbox(
    "Arquivo de log",
    list(por_nome),
    key="arquivo_log",
    format_func=lambda nome: f"{nome}  ({tamanho_mb(por_nome[nome]):.1f} MB)",
)
caminho = por_nome[nome_escolhido]
try:
    info = caminho.stat()
except OSError:
    st.error(f"O arquivo {caminho.name} não está mais disponível.")
    st.stop()
versao = (info.st_size, info.st_mtime_ns)
caminho_str = str(caminho)

try:
    with st.spinner(f"Lendo {caminho.name}... (só na primeira vez; depois fica em cache)"):
        log = carregar_log(caminho_str, versao)
except Exception as erro:
    st.error(f"Não foi possível ler {caminho.name}: {erro}")
    st.stop()
duracao = log["duracao"]
limite = round(duracao + 0.05, 1)

# -----------------------------------------------------------------------
# Escolha do trecho
# -----------------------------------------------------------------------
chave_trecho = f"trecho::{caminho_str}"

# Trecho pedido por um painel ("Analisar trecho do zoom") na execução anterior.
pendente = st.session_state.pop("trecho_pendente", None)
if pendente and pendente[0] == caminho_str:
    definir_trecho(chave_trecho, *trecho_valido(pendente[1], pendente[2], limite))

if chave_trecho not in st.session_state:
    # Começa pelo trecho em voo (economiza processamento em logs com
    # muito tempo parado no solo); se não detectar, usa o log inteiro.
    inicial = log["trecho_em_voo"] or (0.0, duracao)
    definir_trecho(chave_trecho, *trecho_valido(inicial[0], inicial[1], limite))
else:
    # O arquivo pode ter mudado (ficado menor) desde a última execução:
    # garante que o trecho guardado cabe no slider.
    a, b = st.session_state[chave_trecho]
    if a < 0 or b > limite or a > b:
        definir_trecho(chave_trecho, *trecho_valido(a, b, limite))

with st.sidebar.form("form_trecho", border=False):
    inicio, fim = st.slider(
        "Trecho a analisar (segundos desde o início do log)",
        min_value=0.0,
        max_value=limite,
        step=0.5,
        key=chave_trecho,
    )
    st.form_submit_button("Aplicar trecho", type="primary", width="stretch")

if fim - inicio < TRECHO_MINIMO_S:
    st.sidebar.warning("Escolha um trecho de pelo menos 1 segundo.")
    st.stop()

st.sidebar.caption(
    f"{mmss(inicio)} → {mmss(fim)} · {fim - inicio:.0f} s · "
    f"{100 * (fim - inicio) / max(duracao, 1e-9):.0f}% do log ({mmss(duracao)})"
)
col_a, col_b = st.sidebar.columns(2)
col_a.button("Log inteiro", width="stretch",
             on_click=definir_trecho, args=(chave_trecho, 0.0, limite))
if log["trecho_em_voo"]:
    a, b = log["trecho_em_voo"]
    col_b.button("Só o voo", width="stretch", help="Trecho em que a aeronave estava em movimento",
                 on_click=definir_trecho, args=(chave_trecho, round(a, 1), min(limite, round(b, 1))))

st.sidebar.divider()
st.sidebar.caption(
    "Histórico e comparação de voos: `streamlit run visualization/historico.py` e "
    "`streamlit run visualization/comparacao.py`."
)

# -----------------------------------------------------------------------
# Conteúdo: só a aba escolhida é calculada
# -----------------------------------------------------------------------
st.title("Análise de Voo — Adam Aerodesign")
st.caption(f"**{caminho.name}** · trecho {mmss(inicio)} → {mmss(fim)} · altitudes em relação ao solo na decolagem")

aba = st.segmented_control("Aba", list(ABAS), default="Voo", key="aba", label_visibility="collapsed")
contexto = Contexto(caminho=caminho, versao=versao, inicio=float(inicio), fim=float(fim),
                    duracao=duracao, log=log)
ABAS[aba or "Voo"](contexto)
