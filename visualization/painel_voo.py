"""
painel_voo.py

Componente do Streamlit com o painel interativo de voo: valores
instantâneos, gráficos sincronizados e mapa com o trajeto. O painel em
si é HTML/JavaScript (pasta painel_voo_web/) e roda inteiro no
navegador -- o Python só manda os dados do trecho escolhido.

As bibliotecas JavaScript ficam em painel_voo_web/vendor/ e são servidas
localmente (funciona sem internet, exceto as imagens do mapa). O
plotly.min.js é copiado do pacote plotly do Python na primeira execução,
para não precisar guardar uma cópia de ~5 MB no projeto.
"""

import shutil
from pathlib import Path

import plotly
import streamlit.components.v1 as components

PASTA_WEB = Path(__file__).resolve().parent / "painel_voo_web"


def _garantir_plotly_js():
    destino = PASTA_WEB / "vendor" / "plotly.min.js"
    origem = Path(plotly.__file__).resolve().parent / "package_data" / "plotly.min.js"
    # Recopia se o pacote plotly foi atualizado (tamanho diferente).
    if not destino.exists() or destino.stat().st_size != origem.stat().st_size:
        destino.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(origem, destino)


_garantir_plotly_js()
_componente = components.declare_component("painel_voo", path=str(PASTA_WEB))


def painel_voo(dados, key=None):
    """
    Desenha o painel para um pacote de dados (ver dados_voo.montar_painel).
    `dados` precisa ter "id" e "arquivo": o painel só se reconstrói quando
    o "id" muda, então interações em outras partes da página não apagam
    o zoom nem a posição do mapa.

    Devolve None, ou {"acao": "janela", "inicio": s, "fim": s, "nonce": n}
    quando o usuário clica em "Analisar trecho do zoom".
    """
    return _componente(dados=dados, key=key, default=None)
