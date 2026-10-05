"""
replay_voo.py

Componente do Streamlit com o replay 3D do voo (three.js, pasta
replay_voo_web/). Roda inteiro no navegador; o Python só manda o trajeto,
a atitude e os eventos do trecho.
"""

from pathlib import Path

import streamlit.components.v1 as components

PASTA_WEB = Path(__file__).resolve().parent / "replay_voo_web"
_componente = components.declare_component("replay_voo", path=str(PASTA_WEB))


def replay_voo(dados, key=None):
    """`dados` precisa ter "id": o replay só se reconstrói quando o id muda."""
    return _componente(dados=dados, key=key, default=None)
